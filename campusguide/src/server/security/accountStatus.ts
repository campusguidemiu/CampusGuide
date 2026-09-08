import { cacheGet, cacheSet, cacheDel } from "@/server/cache/cache";
import { connectToDatabase } from "@/server/db";
import { AccountStatuses, User, type AccountStatus } from "@/server/models/User";
import type { Role } from "@/server/roles";

/**
 * Authoritative account state, read from the database rather than the JWT.
 *
 * A session token is stateless and lives for weeks, so it can't tell us whether
 * someone was banned thirty seconds ago. Every guarded request re-reads the
 * account, cached briefly so the cost is a memory hit rather than a query.
 */

export type AccountState = {
  id: string;
  status: AccountStatus;
  role: Role;
  name: string;
  miuId: string | null;
  /**
   * Session revocation cut-off, as epoch ms (or null). Stored as ms rather than
   * a Date so the value survives the cache's JSON round-trip unchanged. Every
   * guarded request compares its token's mint time against this — see
   * `isSessionRevoked`.
   */
  sessionsValidFrom: number | null;
};

// Short enough that a ban takes effect almost immediately, long enough that a
// burst of requests from one user doesn't hammer the users collection. Admin
// actions clear the entry outright, so this only bounds out-of-band changes
// (someone editing the database directly, or a second server instance).
// Overridable so the API tests don't have to sleep out a 30-second window.
const STATE_TTL_MS = Number(process.env.ACCOUNT_STATE_TTL_MS ?? 30_000);
const SEEN_TTL_MS = 60_000;

const stateKey = (userId: string) => `user:state:${userId}`;
const seenKey = (userId: string) => `user:seen:${userId}`;

/** Call after any write that changes status or role, so the next request sees it. */
export function invalidateAccountState(userId: string) {
  cacheDel(stateKey(userId));
}

export async function getAccountState(userId: string): Promise<AccountState | null> {
  const cached = cacheGet<AccountState | "missing">(stateKey(userId));
  if (cached) return cached === "missing" ? null : cached;

  await connectToDatabase();
  const user = await User.findById(userId).select("status role name miuId sessionsValidFrom").lean();

  if (!user) {
    // Cache the negative too — a deleted account shouldn't cause a query per request.
    cacheSet(stateKey(userId), "missing", STATE_TTL_MS);
    return null;
  }

  const state: AccountState = {
    id: String(user._id),
    // Accounts created before verification existed have no status; treat them as
    // established users rather than locking everyone out on deploy.
    status: (user.status as AccountStatus) ?? AccountStatuses.Active,
    role: user.role as Role,
    name: user.name,
    miuId: user.miuId ?? null,
    sessionsValidFrom: user.sessionsValidFrom
      ? new Date(user.sessionsValidFrom).getTime()
      : null,
  };

  cacheSet(stateKey(userId), state, STATE_TTL_MS);
  return state;
}

/**
 * Where this request came from, when it is being served inside a request scope.
 *
 * Imported lazily and guarded: `headers()` throws outside a request (a seeding
 * script, a background task), and presence tracking must never be the thing that
 * breaks one.
 */
async function currentConnection(): Promise<{ ip?: string; userAgent?: string }> {
  try {
    const { headers } = await import("next/headers");
    const h = await headers();

    const forwarded = h.get("x-forwarded-for");
    const ip = forwarded ? forwarded.split(",")[0]?.trim() : (h.get("x-real-ip") ?? undefined);

    return {
      ip: ip || undefined,
      userAgent: h.get("user-agent")?.slice(0, 400) || undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Stamps `lastSeenAt`, throttled to once a minute per user. This is what the
 * DAU/WAU/MAU figures are computed from, and what the admin "signed in now"
 * panel reads to show where an account is being used from.
 */
export async function touchLastSeen(userId: string) {
  if (cacheGet<boolean>(seenKey(userId))) return;
  cacheSet(seenKey(userId), true, SEEN_TTL_MS);

  try {
    const { ip, userAgent } = await currentConnection();

    await User.updateOne(
      { _id: userId },
      {
        $set: {
          lastSeenAt: new Date(),
          // Only overwrite when we actually learned something, so a background
          // refresh cannot blank a known address.
          ...(ip ? { lastIp: ip } : {}),
          ...(userAgent ? { lastUserAgent: userAgent } : {}),
        },
      }
    );
  } catch (err) {
    // Presence tracking is not worth failing a request over.
    console.error("lastSeenAt update failed", err);
  }
}
