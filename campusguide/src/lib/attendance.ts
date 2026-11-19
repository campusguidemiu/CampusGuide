/**
 * Attendance maths and the rules for the absence checkboxes.
 *
 * Lectures and labs are ONE pool. A course's sessions are all of its lectures
 * plus all of its labs — 12 weeks of 2 lectures and 1 lab is 36 sessions — and
 * 25% of that pool is how many absences are allowed, whichever kind of session
 * each one was.
 *
 * The invariant this file exists to protect: **the number of absences is never
 * stored.** It is always `missed.length`. A stored count that drifts out of
 * step with the ticked boxes is the one bug that could tell a student they are
 * safe when they are not, so there is deliberately no way to represent that
 * state.
 *
 * Box indices are 0-based and always kept sorted, unique, and inside the
 * course's real session count.
 */

/** MIU bars you from the exam past 25% absence. */
export const MAX_ABSENCE_PERCENT = 25;

export const LIMITS = {
  weeks: { min: 1, max: 30 },
  perWeek: { min: 0, max: 14 },
  nameMax: 80,
} as const;

/**
 * Sent by the Attendance page on every request to the attendance-courses API.
 *
 * A page loaded before lectures and labs were pooled does not send it. The API
 * refuses such a request with "reload" rather than let it write ticks in the
 * old two-list format, or render pooled data with the old per-kind maths.
 */
export const ATTENDANCE_API_VERSION_HEADER = "x-attendance-version";
export const ATTENDANCE_API_VERSION = "2";

export type AttendanceCourse = {
  id: string;
  name: string;
  weeks: number;
  lecturesPerWeek: number;
  hasLab: boolean;
  labsPerWeek: number;
  /** Absence boxes ticked — lectures and labs together, one pool. */
  missed: number[];
};

type CourseShape = Pick<AttendanceCourse, "weeks" | "lecturesPerWeek" | "hasLab" | "labsPerWeek">;

export function totalSessions(weeks: number, perWeek: number) {
  const w = Math.max(0, Math.floor(weeks || 0));
  const p = Math.max(0, Math.floor(perWeek || 0));
  return w * p;
}

/**
 * Every lecture plus every lab: the number the 25% is taken of.
 * 12 weeks × (2 lectures + 1 lab) = 36.
 */
export function courseSessions(course: CourseShape) {
  const lectures = totalSessions(course.weeks, course.lecturesPerWeek);
  const labs = course.hasLab ? totalSessions(course.weeks, course.labsPerWeek) : 0;
  return lectures + labs;
}

/**
 * How many sessions may be missed before the 25% threshold is crossed.
 *
 * Rounded down: at 10 sessions the allowance is 2, not 2.5. Rounding up would
 * tell a student they can miss a session that in fact bars them.
 */
export function allowedAbsences(total: number) {
  return Math.floor((Math.max(0, total) * MAX_ABSENCE_PERCENT) / 100);
}

/**
 * Cleans a set of box indices: integers only, no duplicates, sorted, and
 * nothing at or beyond `total`.
 *
 * The out-of-range trim is the important part. Shortening a course from 14
 * weeks to 10 leaves ticks on sessions that no longer exist; counting them
 * would inflate the absence total against sessions the student cannot even see
 * to untick.
 */
export function normalizeSessions(indices: unknown, total: number): number[] {
  if (!Array.isArray(indices)) return [];
  const max = Math.max(0, Math.floor(total));

  const clean = new Set<number>();
  for (const raw of indices) {
    // Reject these by type before coercing. `Number(null)`, `Number(false)` and
    // `Number("")` are all 0, so a null landing in stored data would otherwise
    // fabricate an absence at session 1 that the student never recorded.
    if (raw === null || raw === undefined || typeof raw === "boolean") continue;
    if (typeof raw === "string" && raw.trim() === "") continue;

    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    const i = Math.floor(n);
    if (i < 0 || i >= max) continue;
    clean.add(i);
  }

  return [...clean].sort((a, b) => a - b);
}

/** Adds or removes one box index. Returns a new sorted array. */
export function toggleSession(indices: number[], index: number, total: number): number[] {
  const current = normalizeSessions(indices, total);
  if (index < 0 || index >= total) return current;

  return current.includes(index)
    ? current.filter((i) => i !== index)
    : normalizeSessions([...current, index], total);
}

export type AbsenceSummary = {
  total: number;
  missed: number;
  allowed: number;
  /** Never negative — "how many more you may miss". */
  remaining: number;
  /** True once the student is past the threshold and at risk of being barred. */
  barred: boolean;
  percent: number;
};

export function summarize(total: number, missedIndices: number[]): AbsenceSummary {
  const missed = normalizeSessions(missedIndices, total).length;
  const allowed = allowedAbsences(total);

  return {
    total,
    missed,
    allowed,
    remaining: Math.max(0, allowed - missed),
    // Strictly greater: missing exactly the allowance is still within the rule.
    barred: missed > allowed,
    percent: total > 0 ? (missed / total) * 100 : 0,
  };
}

export type CourseSummary = AbsenceSummary & {
  /** For the card's overall tone. */
  status: "safe" | "warning" | "barred";
};

/** One summary for the whole course: lectures and labs share the allowance. */
export function summarizeCourse(course: AttendanceCourse): CourseSummary {
  const s = summarize(courseSessions(course), course.missed);

  // "Warning" from the last allowed absence onward — the point at which one
  // more session is the difference between sitting the exam and not.
  const status = s.barred ? "barred" : s.allowed > 0 && s.remaining <= 1 ? "warning" : "safe";

  return { ...s, status };
}

function clampInt(value: unknown, min: number, max: number) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** Clamped course settings. `labsPerWeek` only counts when the course has labs. */
function normalizeShape(raw: {
  weeks?: unknown;
  lecturesPerWeek?: unknown;
  hasLab?: unknown;
  labsPerWeek?: unknown;
}): CourseShape {
  const weeks = clampInt(raw.weeks, LIMITS.weeks.min, LIMITS.weeks.max);
  const lecturesPerWeek = clampInt(raw.lecturesPerWeek, LIMITS.perWeek.min, LIMITS.perWeek.max);
  const hasLab = Boolean(raw.hasLab);
  const labsPerWeek = hasLab ? clampInt(raw.labsPerWeek, LIMITS.perWeek.min, LIMITS.perWeek.max) : 0;
  return { weeks, lecturesPerWeek, hasLab, labsPerWeek };
}

/**
 * Brings a stored course into a state the rest of the app can trust: clamped
 * numbers, and an absence list that fits the current session count.
 */
export function normalizeCourse(raw: Partial<AttendanceCourse> & { id: string; name: string }): AttendanceCourse {
  const shape = normalizeShape(raw);

  return {
    id: raw.id,
    name: String(raw.name ?? "").slice(0, LIMITS.nameMax),
    ...shape,
    missed: normalizeSessions(raw.missed, courseSessions(shape)),
  };
}

/** A course as saved before lectures and labs were pooled: two separate tick lists. */
export type LegacyCourse = {
  weeks?: unknown;
  lecturesPerWeek?: unknown;
  hasLab?: unknown;
  labsPerWeek?: unknown;
  missedLectures?: unknown;
  missedLabs?: unknown;
};

export type LegacyMerge = {
  /** Lecture absences the student had ticked — and could see — before the merge. */
  lectures: number;
  /** Lab absences, likewise. */
  labs: number;
  /** The pooled list: boxes 1..(lectures + labs). */
  missed: number[];
};

/**
 * Turns the two old tick lists into the pooled one. This is the ONLY place
 * that happens: the API (for a course not merged yet) and the migration script
 * both call it, so they cannot disagree.
 *
 * Each old list is cleaned against its OWN old session count first — exactly
 * what the page showed the student — and only then counted. Pooling the raw
 * lists instead would be wrong: a stray lecture tick at index 30 in a
 * 24-lecture course was never shown or counted, but 30 is inside the pooled 36
 * and would become an absence the student never recorded.
 *
 * Which boxes were ticked carries no meaning — a box is "an absence", not a
 * date — so what is kept, exactly, is the count: lectures + labs.
 */
export function mergeLegacyTicks(raw: LegacyCourse): LegacyMerge {
  const shape = normalizeShape(raw);

  const lectures = normalizeSessions(
    raw.missedLectures,
    totalSessions(shape.weeks, shape.lecturesPerWeek)
  ).length;
  const labs = shape.hasLab
    ? normalizeSessions(raw.missedLabs, totalSessions(shape.weeks, shape.labsPerWeek)).length
    : 0;

  return { lectures, labs, missed: Array.from({ length: lectures + labs }, (_, i) => i) };
}

/** "Week 3 · session 2" for the checkbox label. */
export function sessionLabel(index: number, perWeek: number) {
  if (perWeek <= 0) return `Session ${index + 1}`;
  const week = Math.floor(index / perWeek) + 1;
  const nth = (index % perWeek) + 1;
  return perWeek === 1 ? `Week ${week}` : `Week ${week} · #${nth}`;
}
