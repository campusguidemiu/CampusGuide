import { AttendanceCourse } from "@/server/models/AttendanceCourse";
import { noStoreJson } from "@/server/httpCache";
import {
  ATTENDANCE_API_VERSION,
  ATTENDANCE_API_VERSION_HEADER,
  mergeLegacyTicks,
  normalizeCourse,
  type AttendanceCourse as Course,
} from "@/lib/attendance";

/**
 * Server side of pooling lectures and labs into one attendance allowance.
 *
 * Courses saved before the change hold two lists (`missedLectures`,
 * `missedLabs`); courses after it hold one (`missed`). Both API routes go
 * through these helpers, so there is exactly one place that decides how an
 * unmerged course is shown and exactly one place that merges it.
 */

/** A course as read from the database, merged or not. */
export type StoredCourse = {
  _id: unknown;
  name: string;
  weeks: number;
  lecturesPerWeek: number;
  hasLab?: boolean | null;
  labsPerWeek?: number | null;
  missed?: number[] | null;
  missedLectures?: unknown;
  missedLabs?: unknown;
};

/**
 * What the client receives. A course that has not been merged yet is shown
 * merged anyway — computed from its two old lists, nothing written — so every
 * student sees the pooled rule from the moment this is deployed, whether or
 * not the migration has reached their courses.
 */
export function serializeCourse(doc: StoredCourse): Course {
  const missed = Array.isArray(doc.missed) ? doc.missed : mergeLegacyTicks(doc).missed;

  return normalizeCourse({
    id: String(doc._id),
    name: doc.name,
    weeks: doc.weeks,
    lecturesPerWeek: doc.lecturesPerWeek,
    hasLab: Boolean(doc.hasLab),
    labsPerWeek: doc.labsPerWeek ?? 0,
    missed,
  });
}

/** An old list in a guard: a list that was absent has to still be absent. */
function unchanged(value: unknown) {
  return value === undefined ? { $exists: false } : value;
}

/**
 * Merges a course saved in the old two-list format into the pooled `missed`
 * list, once. Every write path calls this first; on a course that is already
 * merged it costs a single read.
 *
 * The write only applies while the course is still unmerged AND its old lists
 * are exactly what was just read:
 * - two requests racing to merge the same course cannot both write;
 * - if the old lists changed in between (a request still finishing on the
 *   previous deployment), the merge is recomputed from the new values instead
 *   of dropping that tick.
 * The old lists themselves are never modified.
 *
 * Returns false when there is no such course for this user.
 */
export async function ensureMerged(filter: { _id: string; userId: string }): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const doc = await AttendanceCourse.findOne(filter).lean<StoredCourse>();
    if (!doc) return false;
    if (Array.isArray(doc.missed)) return true;

    const merge = mergeLegacyTicks(doc);
    const res = await AttendanceCourse.updateOne(
      {
        ...filter,
        missed: { $exists: false },
        missedLectures: unchanged(doc.missedLectures),
        missedLabs: unchanged(doc.missedLabs),
      },
      {
        $set: {
          missed: merge.missed,
          mergedFrom: { lectures: merge.lectures, labs: merge.labs, at: new Date() },
        },
      }
    );
    if (res.matchedCount === 1) return true;
    // Merged by a parallel request, or the old lists moved: read it again.
  }

  throw new Error("Could not merge this course's attendance; nothing was changed.");
}

/**
 * A page loaded before lectures and labs were pooled sends ticks as
 * `{kind, index}` and reads two lists. It must not write in that format, and
 * it must not render pooled data with the old maths, so a request without the
 * current version header is refused — nothing is read or written — and the old
 * page shows this message in its error banner.
 */
export function rejectStaleClient(req: Request) {
  if (req.headers.get(ATTENDANCE_API_VERSION_HEADER) === ATTENDANCE_API_VERSION) return null;

  return noStoreJson(
    { error: "The attendance page was updated. Reload this page — nothing was changed." },
    409
  );
}
