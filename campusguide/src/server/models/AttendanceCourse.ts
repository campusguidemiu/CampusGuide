import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * A manually tracked course on the Attendance page.
 *
 * Absences are stored as the **set of ticked boxes**, not as a count. A count
 * is derivable from the set; a set is not derivable from a count, and the two
 * could drift apart. Since a wrong number here can cost a student their exam,
 * the ticks are the only source of truth.
 *
 * Lectures and labs are one pool: `missed` holds every absence, whichever kind
 * of session it was, against 25% of the lectures and labs together.
 *
 * This lives on the server rather than in localStorage because localStorage is
 * per-device and vanishes when browser data is cleared — a silent, total loss
 * of the record with no way to notice it happened.
 */
const mergedFromSchema = new Schema(
  {
    lectures: { type: Number, required: true, min: 0 },
    labs: { type: Number, required: true, min: 0 },
    at: { type: Date, required: true },
  },
  { _id: false }
);

const attendanceCourseSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    name: { type: String, required: true, maxlength: 80 },
    weeks: { type: Number, required: true, min: 1, max: 30 },
    lecturesPerWeek: { type: Number, required: true, min: 0, max: 14 },
    hasLab: { type: Boolean, default: false },
    labsPerWeek: { type: Number, default: 0, min: 0, max: 14 },

    // Sorted, deduplicated, always inside the course's session count (lectures
    // + labs). The API re-normalizes on every read and write so a malformed
    // client cannot corrupt it.
    //
    // No default, on purpose. Mongoose gives array paths an implicit `[]`; on a
    // course saved before pooling that would read as "no absences", and saving
    // the document would write that empty list over the real ones. Missing
    // means "not merged yet": the API shows it merged on the fly and merges it
    // for real before the first write (server/attendanceCourses.ts).
    missed: { type: [Number], default: undefined },

    // Written once, by the merge: how many lecture and lab absences went into
    // `missed`, and when. Absent on courses created after pooling.
    mergedFrom: { type: mergedFromSchema, default: undefined },

    // LEGACY — the two separate lists from before lectures and labs were
    // pooled. Frozen: nothing writes them any more. They stay as the record of
    // what was merged, and the merge reads them. Declared rather than dropped
    // so the queries that guard on them are cast, never silently stripped.
    missedLectures: { type: [Number], default: undefined },
    missedLabs: { type: [Number], default: undefined },
  },
  { timestamps: true }
);

// One course name per student; re-saving the same name edits it rather than
// creating a second card that splits the absences across two records.
attendanceCourseSchema.index({ userId: 1, name: 1 }, { unique: true });

export type AttendanceCourseDoc = InferSchemaType<typeof attendanceCourseSchema>;

export const AttendanceCourse: Model<AttendanceCourseDoc> =
  (mongoose.models.AttendanceCourse as Model<AttendanceCourseDoc>) ||
  mongoose.model<AttendanceCourseDoc>("AttendanceCourse", attendanceCourseSchema);
