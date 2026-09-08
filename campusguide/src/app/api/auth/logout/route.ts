import { getServerSession } from "next-auth";
import { authOptions } from "@/server/auth";
import { connectToDatabase } from "@/server/db";
import { User } from "@/server/models/User";
import { invalidateAccountState } from "@/server/security/accountStatus";
import { enforceRateLimit } from "@/server/security/rateLimit";
import { logActivity } from "@/server/activity";
import { ActivityActions } from "@/server/models/ActivityLog";
import { isRequestCsrfSafe } from "@/lib/csrf";
import { noStoreJson } from "@/server/httpCache";

/**
 * Real, server-side logout (pentest Finding 1).
 *
 * NextAuth's client `signOut()` only clears the cookie in the browser; a copy of
 * the token captured beforehand keeps working until it expires. This stamps the
 * account's `sessionsValidFrom` cut-off to "now", so every token minted before
 * this instant — including a captured one — is refused by the request guards on
 * their next call. The client still calls `signOut()` afterwards to clear its
 * own cookie; this is what makes that logout actually mean something.
 *
 * Idempotent: logging out with no (or an already-revoked) session is a 200.
 * Lives under `/api/auth`, which the proxy does not guard, so it carries its own
 * CSRF origin check.
 */
export async function POST(req: Request) {
  // Same-origin backstop: a forced logout is low impact, but the check is free.
  const csrfSafe = isRequestCsrfSafe({
    method: "POST",
    origin: req.headers.get("origin"),
    referer: req.headers.get("referer"),
    allowedHosts: [req.headers.get("host"), req.headers.get("x-forwarded-host")],
  });
  if (!csrfSafe) return noStoreJson({ error: "CSRF check failed" }, 403);

  const limited = await enforceRateLimit(req.headers, "auth:logout", { points: 30, duration: 60 });
  if (limited) return limited;

  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) return noStoreJson({ ok: true }); // already signed out

  await connectToDatabase();
  await User.updateOne({ _id: userId }, { $set: { sessionsValidFrom: new Date() } });

  // Drop the cached account state so the very next request re-reads the new
  // cut-off instead of the stale entry that still permits the old token.
  invalidateAccountState(userId);

  void logActivity({
    action: ActivityActions.SignOut,
    actor: { id: userId, name: session?.user?.name ?? null },
    targetId: userId,
    targetType: "user",
    headers: req.headers,
  });

  return noStoreJson({ ok: true });
}
