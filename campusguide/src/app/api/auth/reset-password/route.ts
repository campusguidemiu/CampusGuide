import { z } from "zod";
import bcrypt from "bcrypt";
import { connectToDatabase } from "@/server/db";
import { User } from "@/server/models/User";
import { enforceRateLimit } from "@/server/security/rateLimit";
import { logActivity } from "@/server/activity";
import { ActivityActions } from "@/server/models/ActivityLog";
import { invalidateAccountState } from "@/server/security/accountStatus";
import { hashResetToken, isResetTokenValid } from "@/lib/resetToken";
import { isRequestCsrfSafe } from "@/lib/csrf";
import { noStoreJson } from "@/server/httpCache";

/**
 * Complete a password reset (pentest Finding 3).
 *
 * Consumes the single-use token from `forgot-password`, sets the new password,
 * and — crucially — stamps `sessionsValidFrom` so any session opened with the
 * old password (including an attacker's) is revoked the moment the password
 * changes. The token is cleared on use and on failure never reveals whether the
 * account existed.
 */

const schema = z.object({
  token: z.string().min(10).max(200),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(200, "Password is too long")
    .regex(/[A-Z]/, "Password must include at least 1 uppercase letter")
    .regex(/[0-9]/, "Password must include at least 1 number"),
});

export async function POST(req: Request) {
  const csrfSafe = isRequestCsrfSafe({
    method: "POST",
    origin: req.headers.get("origin"),
    referer: req.headers.get("referer"),
    allowedHosts: [req.headers.get("host"), req.headers.get("x-forwarded-host")],
  });
  if (!csrfSafe) return noStoreJson({ error: "CSRF check failed" }, 403);

  const limited = await enforceRateLimit(req.headers, "auth:reset-password", { points: 10, duration: 60 });
  if (limited) return limited;

  const json = await req.json().catch(() => null);
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return noStoreJson({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
  }

  await connectToDatabase();

  // Look the account up by the hash of the presented token, never the token.
  const user = await User.findOne({ resetTokenHash: hashResetToken(parsed.data.token) });

  if (!user || !isResetTokenValid(parsed.data.token, user.resetTokenHash, user.resetTokenExpiresAt)) {
    return noStoreJson({ error: "This reset link is invalid or has expired." }, 400);
  }

  user.passwordHash = await bcrypt.hash(parsed.data.password, 12);
  // Single-use: burn the token. Set to null rather than undefined — assigning
  // undefined does not reliably unset a path on save(), which would leave the
  // token reusable for its full 30-minute window.
  user.resetTokenHash = null;
  user.resetTokenExpiresAt = null;
  // Revoke every session opened before this reset — the whole point of a reset.
  user.sessionsValidFrom = new Date();
  await user.save();

  invalidateAccountState(String(user._id));

  void logActivity({
    action: ActivityActions.PasswordResetComplete,
    actor: { id: String(user._id), name: user.name, miuId: user.miuId },
    targetId: String(user._id),
    targetType: "user",
    headers: req.headers,
  });

  return noStoreJson({ ok: true, message: "Your password has been reset. You can now sign in." });
}
