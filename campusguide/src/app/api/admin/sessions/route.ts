import { connectToDatabase } from "@/server/db";
import { User } from "@/server/models/User";
import { enforceRateLimit } from "@/server/security/rateLimit";
import { requireRole } from "@/server/security/requireRole";
import { jsonWithEtag, noStoreJson } from "@/server/httpCache";

/**
 * Who is currently using the site, and from where.
 *
 * Sessions are JWTs, so there is no session table to read — "signed in now" is
 * inferred from `lastSeenAt`, which every authenticated request stamps (throttled
 * to once a minute). Someone who closed their tab five minutes ago still counts;
 * that is the honest resolution this can offer, and the window says so.
 *
 * The IP and user agent are the last values seen, not a history. They exist to
 * answer "is this account being used from two places at once" and "which address
 * do I need to block", which is exactly what the block list next to it needs.
 */

const DEFAULT_WINDOW_MINUTES = 15;
const MAX_WINDOW_MINUTES = 60 * 24;

export async function GET(req: Request) {
  const limited = await enforceRateLimit(req.headers, "admin:sessions:get");
  if (limited) return limited;

  const session = await requireRole("admin");
  if (!session) return noStoreJson({ error: "Forbidden" }, 403);

  const url = new URL(req.url);
  const requested = Number(url.searchParams.get("minutes") ?? DEFAULT_WINDOW_MINUTES);
  const minutes = Math.min(
    Math.max(Number.isFinite(requested) ? Math.floor(requested) : DEFAULT_WINDOW_MINUTES, 1),
    MAX_WINDOW_MINUTES
  );

  const since = new Date(Date.now() - minutes * 60 * 1000);

  await connectToDatabase();

  const users = await User.find({ lastSeenAt: { $gte: since } })
    .select("name email miuId role status academicYear lastSeenAt lastIp lastUserAgent")
    .sort({ lastSeenAt: -1 })
    .limit(200)
    .lean();

  const items = users.map((u) => ({
    id: String(u._id),
    name: u.name ?? "",
    email: u.email ?? "",
    miuId: u.miuId ?? null,
    role: u.role ?? "student",
    status: u.status ?? "active",
    academicYear: u.academicYear ?? null,
    lastSeenAt: u.lastSeenAt ? new Date(u.lastSeenAt).toISOString() : null,
    ip: u.lastIp ?? null,
    userAgent: u.lastUserAgent ?? null,
  }));

  // One address serving several accounts is the signal worth surfacing: either a
  // shared computer on campus, or one person running multiple accounts.
  const byIp = new Map<string, number>();
  for (const item of items) {
    if (!item.ip) continue;
    byIp.set(item.ip, (byIp.get(item.ip) ?? 0) + 1);
  }

  const sharedIps = [...byIp.entries()]
    .filter(([, count]) => count > 1)
    .map(([ip, accounts]) => ({ ip, accounts }))
    .sort((a, b) => b.accounts - a.accounts);

  // Polled every 30s while the panel is open - 304 on an unchanged window.
  return jsonWithEtag(req, { items, sharedIps, windowMinutes: minutes }, { cacheControl: "private, no-cache" });
}
