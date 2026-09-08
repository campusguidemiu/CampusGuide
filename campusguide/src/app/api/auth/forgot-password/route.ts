import { z } from "zod";
import { connectToDatabase } from "@/server/db";
import { AccountStatuses, User } from "@/server/models/User";
import { enforceRateLimit } from "@/server/security/rateLimit";
import { logActivity } from "@/server/activity";
import { ActivityActions } from "@/server/models/ActivityLog";
import { isValidMiuId, normalizeMiuId } from "@/lib/miu";
import { createResetToken } from "@/lib/resetToken";
import { isRequestCsrfSafe } from "@/lib/csrf";
import { noStoreJson } from "@/server/httpCache";

/**
 * Request a password reset (pentest Finding 3: replaces the manual WhatsApp
 * process). Issues a single-use, 30-minute, hashed token and records the request
 * in the activity log — the audit trail the manual process never had.
 *
 * Always answers with the same generic 200 whether or not the account exists, so
 * this cannot be used to enumerate valid students. Under `/api/auth`, which the
 * proxy does not guard, so it carries its own CSRF origin check and rate limit.
 *
 * DELIVERY: no email/SMTP is configured in this environment. The reset link is
 * therefore logged server-side (and returned in the response in development
 * only) rather than emailed. Wiring an email sender here is the one remaining
 * step to make this fully self-service in production — the token machinery and
 * audit trail are already in place.
 */

const schema = z.object({
  identifier: z.string().min(3).max(320),
});

const GENERIC = {
  ok: true,
  message: "If an account matches, a password reset link has been issued.",
};

export async function POST(req: Request) {
  const csrfSafe = isRequestCsrfSafe({
    method: "POST",
    origin: req.headers.get("origin"),
    referer: req.headers.get("referer"),
    allowedHosts: [req.headers.get("host"), req.headers.get("x-forwarded-host")],
  });
  if (!csrfSafe) return noStoreJson({ error: "CSRF check failed" }, 403);

  // Tight limit: this triggers a token write and (in production) an email.
  const limited = await enforceRateLimit(req.headers, "auth:forgot-password", { points: 5, duration: 60 });
  if (limited) return limited;

  const json = await req.json().catch(() => null);
  const parsed = schema.safeParse(json);
  if (!parsed.success) return noStoreJson({ error: "Invalid input" }, 400);

  const identifier = parsed.data.identifier.trim();
  await connectToDatabase();

  const asMiuId = normalizeMiuId(identifier);
  const user = isValidMiuId(asMiuId)
    ? await User.findOne({ miuId: asMiuId })
    : await User.findOne({ email: identifier.toLowerCase() });

  // Banned accounts and unknown identifiers get the generic answer with no work.
  if (!user || user.status === AccountStatuses.Banned) return noStoreJson(GENERIC);

  const { token, tokenHash, expiresAt } = createResetToken();
  user.resetTokenHash = tokenHash;
  user.resetTokenExpiresAt = expiresAt;
  await user.save();

  void logActivity({
    action: ActivityActions.PasswordResetRequest,
    actor: { id: String(user._id), name: user.name, miuId: user.miuId },
    targetId: String(user._id),
    targetType: "user",
    headers: req.headers,
  });

  const origin = req.headers.get("origin") ?? `https://${req.headers.get("host") ?? ""}`;
  const resetLink = `${origin}/reset-password?token=${token}`;

  // TODO(email): send `resetLink` to `user.email` once SMTP is configured.
  console.info(`[password-reset] link for ${user.email}: ${resetLink}`);

  // In development, hand the link back so the flow is testable end to end. Never
  // in production — that would let anyone reset any account they can name.
  if (process.env.NODE_ENV !== "production") {
    return noStoreJson({ ...GENERIC, devResetLink: resetLink });
  }

  return noStoreJson(GENERIC);
}
