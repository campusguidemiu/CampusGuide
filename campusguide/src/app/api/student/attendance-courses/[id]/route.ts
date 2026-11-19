import mongoose from "mongoose";
import { NextRequest } from "next/server";
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
import {
  LIMITS,
  courseSessions,
  normalizeCourse,
  type AttendanceCourse as Course,
} from "@/lib/attendance";

const patchSchema = z
  .object({
    /**
     * Record one absence box as ticked or not. The client sends the state it
     * wants, not "flip it".
     *
     * This is deliberate. A "toggle" forces the server to read the current set,
     * flip a bit and write the whole array back — a read-modify-write whose
     * window loses a tick if two arrive together. `absent` maps onto a single
     * atomic $addToSet/$pull, which cannot lose anything and is idempotent, so
     * a retried or duplicated request is harmless.
     *
     * There is no lecture/lab `kind`: lectures and labs are one pool. Strict,
     * so a request still carrying one is refused rather than half-applied.
     */
    set: z
      .object({
        index: z.number().int().min(0).max(999),
        absent: z.boolean(),
      })
      .strict()
      .optional(),
    // Editing the course shape.
    weeks: z.number().int().min(LIMITS.weeks.min).max(LIMITS.weeks.max).optional(),
    lecturesPerWeek: z.number().int().min(LIMITS.perWeek.min).max(LIMITS.perWeek.max).optional(),
    hasLab: z.boolean().optional(),
    labsPerWeek: z.number().int().min(LIMITS.perWeek.min).max(LIMITS.perWeek.max).optional(),
    /** Untick every box. */
    clear: z.literal(true).optional(),
  })
  .strict();

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return noStoreJson({ error: "Unauthorized" }, 401);

  const stale = rejectStaleClient(req);
  if (stale) return stale;

  // Ticking boxes is a rapid activity; budget generously but not unboundedly.
  const limited = await enforceRateLimit(req.headers, "student:attendance-courses:patch", {
    points: 300,
    duration: 60,
    identity: session.user.id,
  });
  if (limited) return limited;

  const { id } = await ctx.params;
  if (!mongoose.isValidObjectId(id)) return noStoreJson({ error: "Invalid id" }, 400);

  const json = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) return noStoreJson({ error: "Invalid input" }, 400);

  await connectToDatabase();

  const filter = { _id: id, userId: session.user.id };

  // A course saved before lectures and labs were pooled is merged before
  // anything is written to it. From then on `missed` is the only list in use.
  if (!(await ensureMerged(filter))) return noStoreJson({ error: "Not found" }, 404);

  // Ticking a box takes the atomic path and returns immediately. It never
  // rewrites the whole array, so concurrent ticks cannot overwrite each other.
  if (parsed.data.set) {
    const { index, absent } = parsed.data.set;

    const current = await AttendanceCourse.findOne(filter).lean<StoredCourse>();
    if (!current) return noStoreJson({ error: "Not found" }, 404);

    if (index >= courseSessions(serializeCourse(current))) {
      return noStoreJson({ error: "That session does not exist in this course." }, 400);
    }

    const updated = await AttendanceCourse.findOneAndUpdate(
      filter,
      absent ? { $addToSet: { missed: index } } : { $pull: { missed: index } },
      { new: true }
    ).lean<StoredCourse>();

    if (!updated) return noStoreJson({ error: "Not found" }, 404);
    return noStoreJson({ course: serializeCourse(updated) }, 200);
  }

  const found = await AttendanceCourse.findOne(filter);
  if (!found) return noStoreJson({ error: "Not found" }, 404);

  // Work from the normalized current state, apply the change, then normalize
  // again. Read-modify-write on the document (rather than a bare $push) is what
  // lets the absences be re-pruned when the course shape changes in the same
  // request.
  const current = serializeCourse(found.toObject() as StoredCourse);
  const next: Course = { ...current };

  if (parsed.data.weeks !== undefined) next.weeks = parsed.data.weeks;
  if (parsed.data.lecturesPerWeek !== undefined) next.lecturesPerWeek = parsed.data.lecturesPerWeek;
  if (parsed.data.hasLab !== undefined) next.hasLab = parsed.data.hasLab;
  if (parsed.data.labsPerWeek !== undefined) next.labsPerWeek = parsed.data.labsPerWeek;

  if (parsed.data.clear) next.missed = [];

  // Re-prune: shrinking the course in this same request may have orphaned ticks.
  const clean = normalizeCourse({ ...next, id: current.id });

  found.set({
    weeks: clean.weeks,
    lecturesPerWeek: clean.lecturesPerWeek,
    hasLab: clean.hasLab,
    labsPerWeek: clean.labsPerWeek,
    missed: clean.missed,
  });
  await found.save();

  // Return the authoritative state so the client can reconcile rather than
  // assume its optimistic guess was right.
  return noStoreJson({ course: serializeCourse(found.toObject() as StoredCourse) }, 200);
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return noStoreJson({ error: "Unauthorized" }, 401);

  const stale = rejectStaleClient(req);
  if (stale) return stale;

  const limited = await enforceRateLimit(req.headers, "student:attendance-courses:delete", {
    points: 60,
    duration: 60,
    identity: session.user.id,
  });
  if (limited) return limited;

  const { id } = await ctx.params;
  if (!mongoose.isValidObjectId(id)) return noStoreJson({ error: "Invalid id" }, 400);

  const res = await connectToDatabase().then(() =>
    AttendanceCourse.deleteOne({ _id: id, userId: session.user.id })
  );
  if (!res.deletedCount) return noStoreJson({ error: "Not found" }, 404);

  return noStoreJson({ ok: true }, 200);
}
