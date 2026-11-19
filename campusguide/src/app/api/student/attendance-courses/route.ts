import { z } from "zod";
import { connectToDatabase } from "@/server/db";
import { requireSession } from "@/server/security/requireSession";
import { enforceRateLimit } from "@/server/security/rateLimit";
import { AttendanceCourse } from "@/server/models/AttendanceCourse";
import { noStoreJson } from "@/server/httpCache";
import {
  ensureMerged,
  rejectStaleClient,
  serializeCourse,
  type StoredCourse,
} from "@/server/attendanceCourses";
import { LIMITS, courseSessions, normalizeCourse, type AttendanceCourse as Course } from "@/lib/attendance";

/**
 * Manually tracked attendance courses.
 *
 * Every response and every write runs through `normalizeCourse`, so what the
 * client receives and what the database holds are both guaranteed to satisfy
 * the invariants in lib/attendance.ts — sorted, deduplicated absence boxes
 * that exist within the course's lectures + labs.
 */

const upsertSchema = z
  .object({
    name: z.string().min(1).max(LIMITS.nameMax).transform((v) => v.trim()),
    weeks: z.number().int().min(LIMITS.weeks.min).max(LIMITS.weeks.max),
    lecturesPerWeek: z.number().int().min(LIMITS.perWeek.min).max(LIMITS.perWeek.max),
    hasLab: z.boolean().optional().default(false),
    labsPerWeek: z.number().int().min(LIMITS.perWeek.min).max(LIMITS.perWeek.max).optional().default(0),
    // Accepted only so the one-off import from localStorage can carry existing
    // ticks across when it CREATES a course. Never applied to a course that
    // already exists: saving a course again must not reset its absences.
    missed: z.array(z.number()).max(500).optional(),
  })
  .strict();

type Shape = Pick<Course, "weeks" | "lecturesPerWeek" | "hasLab" | "labsPerWeek">;

/**
 * Saving a name that already exists edits that course and KEEPS its absences.
 *
 * (This used to `$set` both tick lists to `[]`, so re-saving a course from the
 * form silently erased everything recorded against it.) Only boxes past the
 * new session count are dropped — the same rule as shrinking a course anywhere
 * else — and that `$pull` is atomic, so a tick landing at the same moment is
 * not overwritten.
 */
async function reshape(id: string, userId: string, shape: Shape): Promise<Course | null> {
  const filter = { _id: id, userId };
  if (!(await ensureMerged(filter))) return null;

  const saved = await AttendanceCourse.findOneAndUpdate(
    filter,
    { $set: shape, $pull: { missed: { $gte: courseSessions(shape) } } },
    { new: true }
  ).lean<StoredCourse>();

  return saved ? serializeCourse(saved) : null;
}

export async function GET(req: Request) {
  const session = await requireSession();
  if (!session) return noStoreJson({ error: "Unauthorized" }, 401);

  const stale = rejectStaleClient(req);
  if (stale) return stale;

  const limited = await enforceRateLimit(req.headers, "student:attendance-courses:get", {
    points: 120,
    duration: 60,
    identity: session.user.id,
  });
  if (limited) return limited;

  await connectToDatabase();
  const rows = await AttendanceCourse.find({ userId: session.user.id })
    .sort({ createdAt: -1 })
    .lean<StoredCourse[]>();

  return noStoreJson({ courses: rows.map(serializeCourse) }, 200);
}

export async function POST(req: Request) {
  const session = await requireSession();
  if (!session) return noStoreJson({ error: "Unauthorized" }, 401);

  const stale = rejectStaleClient(req);
  if (stale) return stale;

  const limited = await enforceRateLimit(req.headers, "student:attendance-courses:post", {
    points: 60,
    duration: 60,
    identity: session.user.id,
  });
  if (limited) return limited;

  const json = await req.json().catch(() => null);
  const parsed = upsertSchema.safeParse(json);
  if (!parsed.success) return noStoreJson({ error: "Invalid input" }, 400);

  await connectToDatabase();

  // Normalize before writing so the stored ticks can never reference a box the
  // course does not have.
  const clean = normalizeCourse({ id: "pending", ...parsed.data });
  const shape: Shape = {
    weeks: clean.weeks,
    lecturesPerWeek: clean.lecturesPerWeek,
    hasLab: clean.hasLab,
    labsPerWeek: clean.labsPerWeek,
  };
  const owner = { userId: session.user.id, name: clean.name };

  const existing = await AttendanceCourse.findOne(owner).select({ _id: 1 }).lean();
  if (existing) {
    const course = await reshape(String(existing._id), session.user.id, shape);
    return course ? noStoreJson({ course }, 200) : noStoreJson({ error: "Not found" }, 404);
  }

  try {
    const created = await AttendanceCourse.create({ ...owner, ...shape, missed: clean.missed });
    return noStoreJson({ course: serializeCourse(created.toObject() as StoredCourse) }, 200);
  } catch (err) {
    // The unique (userId, name) index can race two saves of the same new name;
    // the loser becomes an edit of the course the winner just created.
    if ((err as { code?: number })?.code === 11000) {
      const raced = await AttendanceCourse.findOne(owner).select({ _id: 1 }).lean();
      if (raced) {
        const course = await reshape(String(raced._id), session.user.id, shape);
        if (course) return noStoreJson({ course }, 200);
      }
    }
    throw err;
  }
}
