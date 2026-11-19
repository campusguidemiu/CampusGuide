/**
 * Attendance rules.
 *
 * This is the highest-stakes arithmetic in the app: a wrong answer here tells a
 * student they can safely skip a session that in fact bars them from the exam.
 * The rounding direction, the strict-vs-inclusive threshold, the pruning of
 * ticks for sessions that no longer exist, and the one-time merge of the old
 * separate lecture/lab lists are all covered deliberately.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ABSENCE_PERCENT,
  allowedAbsences,
  courseSessions,
  mergeLegacyTicks,
  normalizeCourse,
  normalizeSessions,
  sessionLabel,
  summarize,
  summarizeCourse,
  toggleSession,
  totalSessions,
} from "../src/lib/attendance";

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

// ------------------------------------------------------------ the 25% rule

test("the allowance is 25% of the sessions, rounded down", () => {
  assert.equal(MAX_ABSENCE_PERCENT, 25);
  assert.equal(allowedAbsences(12), 3);
  assert.equal(allowedAbsences(10), 2, "2.5 rounds down to 2, never up");
  assert.equal(allowedAbsences(7), 1, "1.75 rounds down to 1");
  assert.equal(allowedAbsences(3), 0, "0.75 rounds down — no free absences");
  assert.equal(allowedAbsences(0), 0);
});

test("rounding down is what keeps the answer safe", () => {
  // 10 sessions, 25% = 2.5. Telling a student they may miss 3 would be wrong:
  // 3/10 is 30% and bars them.
  const s = summarize(10, [0, 1, 2]);
  assert.equal(s.allowed, 2);
  assert.ok(s.barred, "three of ten is over the line");
});

test("missing exactly the allowance is still allowed", () => {
  const s = summarize(12, [0, 1, 2]);
  assert.equal(s.allowed, 3);
  assert.equal(s.missed, 3);
  assert.equal(s.remaining, 0);
  assert.ok(!s.barred, "at the limit, not past it");
});

test("one more than the allowance bars you", () => {
  const s = summarize(12, [0, 1, 2, 3]);
  assert.ok(s.barred);
  assert.equal(s.remaining, 0, "remaining never goes negative");
});

// ------------------------------------- lectures and labs are one pool

const DLD = { id: "c1", name: "DLD", weeks: 12, lecturesPerWeek: 2, hasLab: true, labsPerWeek: 1 };

test("12 weeks of 2 lectures and 1 lab is 36 sessions with 9 absences allowed", () => {
  assert.equal(courseSessions(DLD), 36);

  const atLimit = summarizeCourse({ ...DLD, missed: range(9) });
  assert.equal(atLimit.total, 36);
  assert.equal(atLimit.allowed, 9);
  assert.equal(atLimit.missed, 9);
  assert.equal(atLimit.remaining, 0);
  assert.ok(!atLimit.barred, "9 of 36 is exactly 25% — still allowed");

  const over = summarizeCourse({ ...DLD, missed: range(10) });
  assert.ok(over.barred, "the 10th absence bars you");
  assert.equal(over.status, "barred");
});

test("the 25% is taken of the pooled total, so it is rounded down once", () => {
  // 14 weeks x (3 lectures + 1 lab) = 56 -> 14. Rounding each kind separately
  // used to give 10 + 3 = 13.
  const c = { id: "c1", name: "Physics", weeks: 14, lecturesPerWeek: 3, hasLab: true, labsPerWeek: 1 };
  assert.equal(courseSessions(c), 56);
  assert.equal(summarizeCourse({ ...c, missed: [] }).allowed, 14);
});

test("the course status follows the pooled allowance", () => {
  // 36 sessions, 9 allowed.
  assert.equal(summarizeCourse({ ...DLD, missed: range(7) }).status, "safe", "2 left");
  assert.equal(summarizeCourse({ ...DLD, missed: range(8) }).status, "warning", "1 left");
  assert.equal(summarizeCourse({ ...DLD, missed: range(9) }).status, "warning", "at the limit");
  assert.equal(summarizeCourse({ ...DLD, missed: range(10) }).status, "barred");
});

test("a course without labs counts only its lectures", () => {
  const c = { id: "c1", name: "Ethics", weeks: 12, lecturesPerWeek: 1, hasLab: false, labsPerWeek: 3 };
  assert.equal(courseSessions(c), 12, "labsPerWeek is ignored when the course has no labs");

  const s = summarizeCourse({ ...c, missed: [] });
  assert.equal(s.total, 12);
  assert.equal(s.allowed, 3);
});

test("a course with no sessions at all allows nothing and divides by nothing", () => {
  const s = summarizeCourse({
    id: "c1", name: "Empty", weeks: 12, lecturesPerWeek: 0, hasLab: false, labsPerWeek: 0, missed: [],
  });
  assert.equal(s.total, 0);
  assert.equal(s.allowed, 0);
  assert.equal(s.percent, 0);
  assert.equal(s.status, "safe");
});

// ------------------------------------------------- count follows the ticks

test("the count is derived from the ticks, never stored separately", () => {
  assert.equal(summarize(20, []).missed, 0);
  assert.equal(summarize(20, [3]).missed, 1);
  assert.equal(summarize(20, [3, 7, 11]).missed, 3);
});

test("duplicate ticks cannot inflate the count", () => {
  // A double-fire on one checkbox must not count as two absences.
  assert.deepEqual(normalizeSessions([2, 2, 2], 10), [2]);
  assert.equal(summarize(10, [2, 2, 2]).missed, 1);
});

test("ticks are stored sorted and deduplicated", () => {
  assert.deepEqual(normalizeSessions([5, 1, 3, 1], 10), [1, 3, 5]);
});

test("junk values are discarded rather than counted", () => {
  assert.deepEqual(normalizeSessions([1, -1, 2.7, NaN, "3", null, undefined, 99], 10), [1, 2, 3]);
  assert.deepEqual(normalizeSessions("not an array" as unknown, 10), []);
  assert.deepEqual(normalizeSessions(null, 10), []);
});

// --------------------------------------- shrinking a course prunes its ticks

test("ticks beyond the last session are dropped, not silently counted", () => {
  // 14 weeks x 2 = 28 sessions, with week 13 missed. Shortened to 10 weeks the
  // course only has 20 sessions, and a tick at index 25 is unreachable in the
  // UI — leaving it would inflate the total against a session nobody can see.
  assert.deepEqual(normalizeSessions([1, 25], 20), [1]);
  assert.equal(summarize(20, [1, 25]).missed, 1);
});

test("shrinking a course through normalizeCourse prunes absences past the new session count", () => {
  // 10 weeks x (2 + 1) = 30 boxes.
  const shortened = normalizeCourse({
    id: "c1",
    name: "Physics",
    weeks: 10,
    lecturesPerWeek: 2,
    hasLab: true,
    labsPerWeek: 1,
    missed: [0, 5, 29, 30, 41],
  });

  assert.deepEqual(shortened.missed, [0, 5, 29], "30 and 41 are past the 30 sessions");
});

test("turning labs off keeps the absences that still fit the lectures", () => {
  // One pool: an absence has no lecture/lab kind any more, so turning labs off
  // cannot pick out "the lab ones". Only boxes past the new count go.
  const c = normalizeCourse({
    id: "c1",
    name: "Maths",
    weeks: 10,
    lecturesPerWeek: 2,
    hasLab: false,
    labsPerWeek: 2,
    missed: [0, 1, 19, 20, 25],
  });
  assert.equal(c.labsPerWeek, 0);
  assert.deepEqual(c.missed, [0, 1, 19], "20 lecture sessions remain");
});

test("out-of-range course settings are clamped, not trusted", () => {
  const c = normalizeCourse({
    id: "c1",
    name: "x".repeat(200),
    weeks: 9999,
    lecturesPerWeek: -3,
    hasLab: true,
    labsPerWeek: 999,
  });
  assert.equal(c.weeks, 30);
  assert.equal(c.lecturesPerWeek, 0);
  assert.equal(c.labsPerWeek, 14);
  assert.equal(c.name.length, 80);
  assert.deepEqual(c.missed, [], "a missing list is no absences, not junk");
});

// ------------------------------------------------------------- toggling

test("toggling adds then removes the same session", () => {
  let ticks: number[] = [];
  ticks = toggleSession(ticks, 4, 20);
  assert.deepEqual(ticks, [4]);
  ticks = toggleSession(ticks, 4, 20);
  assert.deepEqual(ticks, [], "clicking twice leaves no trace");
});

test("toggling keeps the list sorted", () => {
  let ticks: number[] = [];
  for (const i of [9, 2, 5]) ticks = toggleSession(ticks, i, 20);
  assert.deepEqual(ticks, [2, 5, 9]);
});

test("toggling a session that does not exist changes nothing", () => {
  assert.deepEqual(toggleSession([1], 50, 20), [1]);
  assert.deepEqual(toggleSession([1], -1, 20), [1]);
});

// ------------------------------------------------------------- summaries

test("totals are weeks times sessions per week", () => {
  assert.equal(totalSessions(14, 2), 28);
  assert.equal(totalSessions(10, 0), 0);
  assert.equal(totalSessions(0, 3), 0);
});

test("percentages reflect the ticks", () => {
  assert.equal(summarize(20, [0, 1, 2, 3, 4]).percent, 25);
  assert.equal(summarize(0, []).percent, 0, "no division by zero on an empty course");
});

// ---------------------------------------------------------------- labels

test("session labels name the week they fall in", () => {
  assert.equal(sessionLabel(0, 2), "Week 1 · #1");
  assert.equal(sessionLabel(1, 2), "Week 1 · #2");
  assert.equal(sessionLabel(2, 2), "Week 2 · #1");
  assert.equal(sessionLabel(0, 1), "Week 1", "no #1 suffix when there is one a week");
  assert.equal(sessionLabel(3, 0), "Session 4", "degenerate case still labels something");
});

// =================================================================
// Merging the old separate lecture/lab lists into the pooled list.
// =================================================================

test("merging keeps the exact number of absences: lectures + labs", () => {
  const m = mergeLegacyTicks({ ...DLD, missedLectures: [0, 1, 2], missedLabs: [0, 1] });
  assert.deepEqual(m, { lectures: 3, labs: 2, missed: [0, 1, 2, 3, 4] });
});

test("merging closes gaps without changing the count", () => {
  // Box 2 ticked, box 1 empty: still one absence, shown as the first box.
  assert.deepEqual(mergeLegacyTicks({ ...DLD, missedLectures: [1], missedLabs: [] }), {
    lectures: 1,
    labs: 0,
    missed: [0],
  });
  assert.deepEqual(mergeLegacyTicks({ ...DLD, missedLectures: [0, 1, 2], missedLabs: [1] }).missed, [0, 1, 2, 3]);
});

test("a stray tick past the lecture count does not become an absence when pooled", () => {
  // 24 lectures. Index 30 was never on screen and never counted — but it IS
  // inside the pooled 36, so merging the raw lists would invent an absence.
  const m = mergeLegacyTicks({ ...DLD, missedLectures: [0, 30], missedLabs: [] });
  assert.equal(m.lectures, 1);
  assert.deepEqual(m.missed, [0]);
});

test("a stray tick past the lab count is not counted either", () => {
  const m = mergeLegacyTicks({ ...DLD, missedLectures: [], missedLabs: [11, 12] });
  assert.equal(m.labs, 1, "12 labs: index 11 is the last real one");
});

test("leftover lab ticks on a course with labs turned off are not counted", () => {
  // The page showed no lab section for this course, so these were never counted.
  const m = mergeLegacyTicks({ ...DLD, hasLab: false, missedLectures: [0], missedLabs: [0, 1] });
  assert.deepEqual(m, { lectures: 1, labs: 0, missed: [0] });
});

test("junk, duplicates and missing lists in old records are not counted", () => {
  assert.equal(mergeLegacyTicks({ ...DLD, missedLectures: [2, 2, null, "", true, -1, NaN] }).lectures, 1);
  assert.deepEqual(mergeLegacyTicks({ ...DLD }), { lectures: 0, labs: 0, missed: [] });
  assert.deepEqual(mergeLegacyTicks({ ...DLD, missedLectures: "3" as unknown, missedLabs: 7 as unknown }).missed, []);
});

// -------------------------------------------------------------------------
// FROZEN COPY of the rules from before lectures and labs were pooled. Never
// edit this block: the sweep below checks the merge against exactly what each
// student saw on screen before it, independent of the current code.
// -------------------------------------------------------------------------
const frozen = (() => {
  function totalSessionsOld(weeks: number, perWeek: number) {
    const w = Math.max(0, Math.floor(weeks || 0));
    const p = Math.max(0, Math.floor(perWeek || 0));
    return w * p;
  }
  function normalizeSessionsOld(indices: unknown, total: number): number[] {
    if (!Array.isArray(indices)) return [];
    const max = Math.max(0, Math.floor(total));
    const clean = new Set<number>();
    for (const raw of indices) {
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
  function summarizeOld(total: number, missedIndices: number[]) {
    const missed = normalizeSessionsOld(missedIndices, total).length;
    const allowed = Math.floor((Math.max(0, total) * 25) / 100);
    return { total, missed, allowed, remaining: Math.max(0, allowed - missed), barred: missed > allowed };
  }
  type OldCourse = {
    weeks: number;
    lecturesPerWeek: number;
    hasLab: boolean;
    labsPerWeek: number;
    missedLectures: number[];
    missedLabs: number[];
  };
  function normalizeCourseOld(raw: Record<string, unknown>): OldCourse {
    const clamp = (v: unknown, min: number, max: number) => {
      const n = Math.floor(Number(v));
      if (!Number.isFinite(n)) return min;
      return Math.min(max, Math.max(min, n));
    };
    const weeks = clamp(raw.weeks, 1, 30);
    const lecturesPerWeek = clamp(raw.lecturesPerWeek, 0, 14);
    const hasLab = Boolean(raw.hasLab);
    const labsPerWeek = hasLab ? clamp(raw.labsPerWeek, 0, 14) : 0;
    return {
      weeks,
      lecturesPerWeek,
      hasLab,
      labsPerWeek,
      missedLectures: normalizeSessionsOld(raw.missedLectures, totalSessionsOld(weeks, lecturesPerWeek)),
      missedLabs: hasLab ? normalizeSessionsOld(raw.missedLabs, totalSessionsOld(weeks, labsPerWeek)) : [],
    };
  }
  function summarizeCourseOld(course: OldCourse) {
    const lectures = summarizeOld(totalSessionsOld(course.weeks, course.lecturesPerWeek), course.missedLectures);
    const labs = course.hasLab
      ? summarizeOld(totalSessionsOld(course.weeks, course.labsPerWeek), course.missedLabs)
      : null;
    const parts = labs ? [lectures, labs] : [lectures];
    const barred = parts.some((p) => p.barred);
    const warning = parts.some((p) => !p.barred && p.allowed > 0 && p.remaining <= 1);
    return { parts, status: barred ? "barred" : warning ? "warning" : "safe" };
  }
  return { normalizeCourse: normalizeCourseOld, summarizeCourse: summarizeCourseOld };
})();

test("4 missed labs no longer bar a course on their own — they come out of the shared 9", () => {
  const legacy = { ...DLD, missedLectures: [] as number[], missedLabs: [0, 1, 2, 3] };
  assert.equal(frozen.summarizeCourse(frozen.normalizeCourse(legacy)).status, "barred", "the old rule");

  const pooled = summarizeCourse(normalizeCourse({ ...DLD, missed: mergeLegacyTicks(legacy).missed }));
  assert.equal(pooled.missed, 4);
  assert.equal(pooled.status, "safe", "4 of 36 with 9 allowed");
});

/** Deterministic PRNG so a failure here can be reproduced exactly. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const JUNK: unknown[] = [null, undefined, "", " ", true, false, NaN, Infinity, -1, -0.5, 2.5, "3", "x", {}, []];

function randomTicks(rand: () => number, total: number): unknown[] {
  const len = Math.floor(rand() * (total + 6));
  const out: unknown[] = [];
  for (let i = 0; i < len; i++) {
    out.push(rand() < 0.08 ? JUNK[Math.floor(rand() * JUNK.length)] : Math.floor(rand() * (total + 8)) - 2);
  }
  return out;
}

const RANK = { safe: 0, warning: 1, barred: 2 } as const;

test("for every course shape, the merge keeps each student's count and never makes them worse off", () => {
  const rand = mulberry32(20261119);
  let cases = 0;

  for (let weeks = 1; weeks <= 30; weeks++) {
    for (let lecturesPerWeek = 0; lecturesPerWeek <= 14; lecturesPerWeek++) {
      for (const hasLab of [true, false]) {
        for (let labsPerWeek = 0; labsPerWeek <= 14; labsPerWeek++) {
          for (let k = 0; k < 2; k++) {
            const legacy = {
              weeks,
              lecturesPerWeek,
              hasLab,
              labsPerWeek,
              missedLectures: randomTicks(rand, weeks * lecturesPerWeek),
              missedLabs: randomTicks(rand, weeks * labsPerWeek),
            };
            const where = JSON.stringify({ weeks, lecturesPerWeek, hasLab, labsPerWeek, k });

            const before = frozen.normalizeCourse(legacy);
            const oldSummary = frozen.summarizeCourse(before);
            const m = mergeLegacyTicks(legacy);

            // 1. Exactly what the student saw: same lecture count, same lab count.
            assert.equal(m.lectures, before.missedLectures.length, `lectures ${where}`);
            assert.equal(m.labs, before.missedLabs.length, `labs ${where}`);
            assert.deepEqual(m.missed, range(m.lectures + m.labs), `boxes ${where}`);

            // 2. All of them fit the pooled course — none is trimmed away.
            const after = normalizeCourse({ id: "c", name: "c", ...legacy, missed: m.missed });
            const pooled = summarizeCourse(after);
            assert.equal(pooled.missed, m.lectures + m.labs, `nothing trimmed ${where}`);

            // 3. Pooling only ever adds room.
            const oldAllowed = oldSummary.parts.reduce((sum, p) => sum + p.allowed, 0);
            assert.ok(pooled.allowed >= oldAllowed, `allowance shrank ${where}`);

            // 4. Nobody who was within the rule becomes barred.
            if (oldSummary.status !== "barred") assert.ok(!pooled.barred, `newly barred ${where}`);

            // 5. The status never gets worse — with one honest exception: when
            //    every old part allowed 0 absences (3 or fewer sessions of each
            //    kind), the old card said "Safe" although a single absence
            //    barred you. Pooled, those courses have 1+ allowed and may show
            //    "1 left", which is the more accurate of the two.
            if (RANK[pooled.status] > RANK[oldSummary.status as keyof typeof RANK]) {
              assert.ok(
                oldSummary.parts.every((p) => p.allowed === 0),
                `status got worse ${where}: ${oldSummary.status} -> ${pooled.status}`
              );
            }
            cases++;
          }
        }
      }
    }
  }

  assert.equal(cases, 30 * 15 * 2 * 15 * 2);
});

test("the merge reads stored values the way the old page did", () => {
  // Numbers stored as strings, a missing labsPerWeek, a null list — the old
  // page coerced these, so the merge must coerce them identically.
  const odd = { weeks: "12", lecturesPerWeek: "2", hasLab: 1, labsPerWeek: undefined, missedLectures: [0, "1"], missedLabs: null };
  const before = frozen.normalizeCourse(odd);
  const m = mergeLegacyTicks(odd);
  assert.equal(m.lectures, before.missedLectures.length);
  assert.equal(m.labs, before.missedLabs.length);
  assert.equal(m.lectures, 2);
});
