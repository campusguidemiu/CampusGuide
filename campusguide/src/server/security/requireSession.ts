import { getServerSession } from "next-auth";
import { authOptions } from "@/server/auth";
import { AccountStatuses } from "@/server/models/User";
import { getAccountState, touchLastSeen } from "@/server/security/accountStatus";
import { isSessionRevoked } from "@/lib/session";

type Options = {
  /**
   * Skip the active-account requirement. Only for surfaces a pending user is
   * meant to reach — the "send your ID" screen and the auth pages.
   */
  allowAnyStatus?: boolean;
};

/**
 * A signed-in session belonging to an account that is still allowed in.
 *
 * Banned and unverified accounts hold valid JWTs, so the token alone is not
 * enough — the account is re-checked (from a short-lived cache) on every call.
 */
export async function requireSession(options: Options = {}) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return null;

  const state = await getAccountState(session.user.id);
  if (!state) return null;

  // Server-side logout / password-reset revocation. A token minted before the
  // account's cut-off is refused even though the JWT is still valid — this is
  // what actually ends a session server-side, since a JWT cannot be deleted.
  if (isSessionRevoked((session as any).loginAt, state.sessionsValidFrom)) return null;

  if (!options.allowAnyStatus && state.status !== AccountStatuses.Active) return null;

  // Presence is recorded for real users on real requests, not for rejected ones.
  void touchLastSeen(session.user.id);

  return session;
}
