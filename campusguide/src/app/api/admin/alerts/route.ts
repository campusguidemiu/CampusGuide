import mongoose from "mongoose";
import { z } from "zod";
import { connectToDatabase } from "@/server/db";
import { requireRole } from "@/server/security/requireRole";
import { enforceRateLimit } from "@/server/security/rateLimit";
import { SecurityAlert } from "@/server/models/SecurityAlert";
import { jsonWithEtag, noStoreJson } from "@/server/httpCache";
import { logActivity } from "@/server/activity";
import { ActivityActions } from "@/lib/activityActions";
import {
  ALERT_STATUS_VALUES,
  AlertSeverities,
  AlertStatuses,
  AlertTypes,
  encodeAlertCursor,
  parseAlertCursor,
} from "@/lib/alerts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Open alerts by default, so the overview card and the sidebar badge keep the
 * contract they were written against. The history view on the activity log asks
 * for more with `status`, `type`, `severity` and a cursor.
 */
export async function GET(req: Request) {
  const session = await requireRole("admin");
  if (!session) return noStoreJson({ error: "Forbidden" }, 403);

  // Polled every 20s per open dashboard, so the budget is generous.
  const limited = await enforceRateLimit(req.headers, "admin:alerts:get", {
    points: 300,
    duration: 60,
    identity: session.user.id,
  });
  if (limited) return limited;

  await connectToDatabase();

  const url = new URL(req.url);

  // `?all=1` predates the status filter and is still what nothing-in-particular
  // sends; keep honouring it rather than breaking a caller to tidy the API.
  const legacyAll = url.searchParams.get("all") === "1";
  const requestedStatus = url.searchParams.get("status");
  const status =
    requestedStatus && (ALERT_STATUS_VALUES as readonly string[]).includes(requestedStatus)
      ? requestedStatus
      : legacyAll
        ? AlertStatuses.All
        : AlertStatuses.Open;

  const filter: Record<string, unknown> = {};

  if (status === AlertStatuses.Open) filter.acknowledgedAt = { $exists: false };
  if (status === AlertStatuses.Acknowledged) filter.acknowledgedAt = { $exists: true };

  const type = url.searchParams.get("type");
  if (type && (Object.values(AlertTypes) as string[]).includes(type)) filter.type = type;

  const severity = url.searchParams.get("severity");
  if (severity && (Object.values(AlertSeverities) as string[]).includes(severity)) {
    filter.severity = severity;
  }

  const requestedLimit = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT;
  const limit = Math.min(Math.max(Math.floor(requestedLimit), 1), MAX_LIMIT);

  // Paging keys on (lastSeenAt, _id) rather than lastSeenAt alone: two alerts
  // raised in the same millisecond would otherwise straddle a page boundary and
  // one of them would never be shown.
  const cursor = parseAlertCursor(url.searchParams.get("before"));
  if (cursor) {
    filter.$or = [
      { lastSeenAt: { $lt: cursor.lastSeenAt } },
      { lastSeenAt: cursor.lastSeenAt, _id: { $lt: new mongoose.Types.ObjectId(cursor.id) } },
    ];
  }

  const [rows, openCount, acknowledgedCount] = await Promise.all([
    SecurityAlert.find(filter)
      .sort({ lastSeenAt: -1, _id: -1 })
      // One extra row is fetched purely to know whether another page exists.
      .limit(limit + 1)
      .lean(),
    SecurityAlert.countDocuments({ acknowledgedAt: { $exists: false } }),
    SecurityAlert.countDocuments({ acknowledgedAt: { $exists: true } }),
  ]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const alerts = page.map((a) => ({
    id: String(a._id),
    type: a.type,
    severity: a.severity,
    subject: a.subject,
    subjectLabel: a.subjectLabel ?? null,
    userId: a.userId ? String(a.userId) : null,
    count: a.count,
    message: a.message,
    firstSeenAt: a.firstSeenAt ? new Date(a.firstSeenAt).toISOString() : null,
    lastSeenAt: a.lastSeenAt ? new Date(a.lastSeenAt).toISOString() : null,
    acknowledgedAt: a.acknowledgedAt ? new Date(a.acknowledgedAt).toISOString() : null,
    acknowledgedByName: a.acknowledgedByName ?? null,
  }));

  const last = page[page.length - 1];

  // Polled every 20s by both the sidebar badge and the dashboard card, and
  // unchanged on the overwhelming majority of those polls.
  return jsonWithEtag(
    req,
    {
      alerts,
      // Unchanged key: the sidebar badge and the overview card read this.
      openCount,
      counts: {
        open: openCount,
        acknowledged: acknowledgedCount,
        total: openCount + acknowledgedCount,
      },
      nextCursor:
        hasMore && last?.lastSeenAt
          ? encodeAlertCursor(new Date(last.lastSeenAt).toISOString(), String(last._id))
          : null,
    },
    { status: 200, cacheControl: "private, no-cache" }
  );
}

const ackSchema = z.object({ id: z.string() }).strict();

/** Acknowledge one alert. It leaves the dashboard but stays in the record. */
export async function PATCH(req: Request) {
  const session = await requireRole("admin");
  if (!session) return noStoreJson({ error: "Forbidden" }, 403);

  const limited = await enforceRateLimit(req.headers, "admin:alerts:patch", {
    points: 120,
    duration: 60,
    identity: session.user.id,
  });
  if (limited) return limited;

  const json = await req.json().catch(() => null);
  const parsed = ackSchema.safeParse(json);
  if (!parsed.success || !mongoose.isValidObjectId(parsed.data.id)) {
    return noStoreJson({ error: "Invalid input" }, 400);
  }

  await connectToDatabase();

  const alert = await SecurityAlert.findOneAndUpdate(
    { _id: parsed.data.id, acknowledgedAt: { $exists: false } },
    {
      $set: {
        acknowledgedAt: new Date(),
        acknowledgedBy: session.user.id,
        acknowledgedByName: session.user.name,
      },
    },
    { new: true }
  ).lean();

  if (!alert) return noStoreJson({ error: "Not found" }, 404);

  void logActivity({
    action: ActivityActions.AlertAcknowledged,
    actor: { id: session.user.id, name: session.user.name },
    targetId: String(alert._id),
    targetType: "securityAlert",
    targetLabel: alert.message,
    headers: req.headers,
  });

  return noStoreJson({ ok: true }, 200);
}
