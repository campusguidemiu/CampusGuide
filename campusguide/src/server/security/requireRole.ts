import { getServerSession } from "next-auth";
import { authOptions } from "@/server/auth";
import { AccountStatuses } from "@/server/models/User";
import { getAccountState, touchLastSeen } from "@/server/security/accountStatus";
import { isSessionRevoked } from "@/lib/session";

/**
 * Like requireSession, but also asserts the role — and reads the role from the
 * database rather than the JWT, so a demoted admin loses access immediately
 * instead of when their token expires.
 */
export async function requireRole(role: "student" | "admin") {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return null;

  const state = await getAccountState(session.user.id);
  if (!state) return null;
  if (isSessionRevoked((session as any).loginAt, state.sessionsValidFrom)) return null;
  if (state.status !== AccountStatuses.Active) return null;
  if (state.role !== role) return null;

  void touchLastSeen(session.user.id);

  return session;
}
