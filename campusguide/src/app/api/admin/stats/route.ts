import { connectToDatabase } from "@/server/db";
import { AccountStatuses, User } from "@/server/models/User";
import { ActivityLog } from "@/server/models/ActivityLog";
import { Resource } from "@/server/models/Resource";
import { Folder } from "@/server/models/Folder";
import { enforceRateLimit } from "@/server/security/rateLimit";
import { requireRole } from "@/server/security/requireRole";
import { jsonWithEtag, noStoreJson } from "@/server/httpCache";

function daysAgo(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/**
 * Headline numbers for the admin overview.
 *
 * Active-user counts come from `lastSeenAt`, which every authenticated request
 * stamps (throttled to once a minute per user).
 */
export async function GET(req: Request) {
  const limited = await enforceRateLimit(req.headers, "admin:stats:get");
  if (limited) return limited;

  const session = await requireRole("admin");
  if (!session) return noStoreJson({ error: "Forbidden" }, 403);

  await connectToDatabase();

  const day = daysAgo(1);
  const week = daysAgo(7);
  const month = daysAgo(30);

  const [
    dau,
    wau,
    mau,
    totalUsers,
    pending,
    banned,
    newToday,
    newThisWeek,
    resources,
    folders,
    actionsToday,
  ] = await Promise.all([
    User.countDocuments({ lastSeenAt: { $gte: day } }),
    User.countDocuments({ lastSeenAt: { $gte: week } }),
    User.countDocuments({ lastSeenAt: { $gte: month } }),
    User.countDocuments({}),
    User.countDocuments({ status: AccountStatuses.Pending }),
    User.countDocuments({ status: AccountStatuses.Banned }),
    User.countDocuments({ createdAt: { $gte: day } }),
    User.countDocuments({ createdAt: { $gte: week } }),
    Resource.countDocuments({}),
    Folder.countDocuments({}),
    ActivityLog.countDocuments({ createdAt: { $gte: day } }),
  ]);

  // Signups per day for the last fortnight, for the overview sparkline.
  const signupSeries = await User.aggregate([
    { $match: { createdAt: { $gte: daysAgo(14) } } },
    { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);

  // Polled by the sidebar badge every 60s; the numbers rarely move between
  // two polls, so an ETag makes most of those a 304 with no body.
  return jsonWithEtag(
    req,
    {
      activeUsers: { daily: dau, weekly: wau, monthly: mau },
      users: { total: totalUsers, pending, banned, active: totalUsers - pending - banned },
      signups: { today: newToday, thisWeek: newThisWeek },
      content: { resources, folders },
      actionsToday,
      signupSeries: signupSeries.map((row: any) => ({ date: row._id as string, count: row.count as number })),
    },
    { cacheControl: "private, no-cache" }
  );
}
