"use client";

import * as React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Check, Cloud, CloudOff, Loader2, Trash2, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  ATTENDANCE_API_VERSION,
  ATTENDANCE_API_VERSION_HEADER,
  LIMITS,
  MAX_ABSENCE_PERCENT,
  courseSessions,
  summarizeCourse,
  totalSessions,
  type AttendanceCourse,
} from "@/lib/attendance";

const LEGACY_KEY = "cg:attendance:courses:v1";
const MIGRATED_KEY = "cg:attendance:migrated:v2";

function toInt(value: string, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

/**
 * Every call to the attendance API carries the version header. The server
 * refuses requests without it, which is what stops a tab opened before
 * lectures and labs were pooled from writing in the old format.
 */
function attendanceApi(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set(ATTENDANCE_API_VERSION_HEADER, ATTENDANCE_API_VERSION);
  return fetch(path, { ...init, headers });
}

/**
 * One checkbox per absence, not per week.
 *
 * A student tracks "how many of my allowed absences have I used", and does not
 * know or care which calendar week a box stands for. So the grid shows the
 * allowance itself — three boxes when you are allowed three — and only grows
 * past that when the allowance is actually exceeded.
 */
function AbsenceGrid({
  total,
  allowed,
  missed,
  disabled,
  onToggle,
}: {
  total: number;
  allowed: number;
  missed: number[];
  disabled: boolean;
  onToggle: (index: number) => void;
}) {
  if (total === 0) {
    return <p className="text-sm text-foreground/55">This course has no sessions.</p>;
  }

  const missedSet = new Set(missed);

  // Every ticked box must render. Sizing from the allowance alone could hide a
  // tick at a higher index, which would count against the student with no box
  // on screen to untick — the exact failure this page must never have.
  const highestTicked = missed.length > 0 ? Math.max(...missed) : -1;
  const visible = Math.min(total, Math.max(allowed, highestTicked + 2));

  return (
    <div className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
      {Array.from({ length: visible }, (_, i) => {
        const checked = missedSet.has(i);
        const overLimit = i >= allowed;

        return (
          <label
            key={i}
            className={cn(
              "flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2.5 text-sm transition-colors",
              checked
                ? "border-risk/50 bg-risk/15 font-semibold text-risk"
                : overLimit
                  ? "border-risk/25 border-dashed bg-background text-foreground/60 hover:border-risk/45"
                  : "border-foreground/12 bg-background hover:border-foreground/25",
              disabled && "cursor-not-allowed opacity-60"
            )}
          >
            <input
              type="checkbox"
              className="h-4 w-4 shrink-0 accent-risk"
              checked={checked}
              disabled={disabled}
              onChange={() => onToggle(i)}
              aria-label={
                overLimit
                  ? `Absence ${i + 1} — over your allowance`
                  : `Absence ${i + 1} of ${allowed} allowed`
              }
            />
            <span className="truncate">
              Absence {i + 1}
              {overLimit ? <span className="ml-1 text-xs font-bold text-risk">over</span> : null}
            </span>
          </label>
        );
      })}
    </div>
  );
}

export default function AttendancePage() {
  const [courses, setCourses] = React.useState<AttendanceCourse[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);

  const [courseName, setCourseName] = React.useState("");
  const [weeks, setWeeks] = React.useState("12");
  const [lecturesPerWeek, setLecturesPerWeek] = React.useState("2");
  const [hasLab, setHasLab] = React.useState(true);
  const [labsPerWeek, setLabsPerWeek] = React.useState("1");

  const load = React.useCallback(async () => {
    try {
      const res = await attendanceApi("/api/student/attendance-courses");
      const j = await res.json().catch(() => null);
      if (!res.ok) {
        setError(j?.error ?? "Could not load your courses.");
        return null;
      }
      setCourses(j.courses as AttendanceCourse[]);
      setError(null);
      return j.courses as AttendanceCourse[];
    } catch {
      setError("Network error — your attendance could not be loaded. Do not rely on this page until it does.");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  // One-off lift of anything still sitting in localStorage from the old
  // device-local version, so nobody loses a term's worth of ticks.
  React.useEffect(() => {
    let cancelled = false;

    (async () => {
      const existing = await load();
      if (cancelled || !existing || existing.length > 0) return;
      if (localStorage.getItem(MIGRATED_KEY)) return;

      try {
        const raw = localStorage.getItem(LEGACY_KEY);
        localStorage.setItem(MIGRATED_KEY, "1");
        if (!raw) return;

        const legacy = JSON.parse(raw) as Array<Record<string, unknown>>;
        if (!Array.isArray(legacy) || legacy.length === 0) return;

        for (const c of legacy) {
          const w = Number(c.weeks) || 1;
          const lpw = Number(c.lecturesPerWeek) || 0;
          const lab = Boolean(c.hasLab);
          const labpw = lab ? Number(c.labsPerWeek) || 0 : 0;

          // The old format stored only counts. The specific sessions are
          // unknowable, so the first N boxes are ticked — N being the lecture
          // and lab absences together, since they share one allowance now.
          const nLect = Math.min(Number(c.missedLectures) || 0, totalSessions(w, lpw));
          const nLab = Math.min(Number(c.missedLabs) || 0, totalSessions(w, labpw));

          await attendanceApi("/api/student/attendance-courses", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: String(c.name ?? "Untitled").slice(0, LIMITS.nameMax),
              weeks: Math.min(Math.max(w, LIMITS.weeks.min), LIMITS.weeks.max),
              lecturesPerWeek: Math.min(lpw, LIMITS.perWeek.max),
              hasLab: lab,
              labsPerWeek: Math.min(labpw, LIMITS.perWeek.max),
              missed: Array.from({ length: nLect + nLab }, (_, i) => i),
            }),
          });
        }

        if (!cancelled) await load();
      } catch {
        // A failed migration leaves localStorage untouched and the server empty;
        // nothing is destroyed either way.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [load]);

  async function addCourse() {
    const name = courseName.trim();
    if (!name) return;

    setSaving((n) => n + 1);
    try {
      const res = await attendanceApi("/api/student/attendance-courses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          weeks: Math.min(Math.max(toInt(weeks, 12), LIMITS.weeks.min), LIMITS.weeks.max),
          lecturesPerWeek: Math.min(toInt(lecturesPerWeek), LIMITS.perWeek.max),
          hasLab,
          labsPerWeek: hasLab ? Math.min(toInt(labsPerWeek), LIMITS.perWeek.max) : 0,
        }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) {
        setError(j?.error ?? "Could not save that course.");
        return;
      }
      setCourseName("");
      setError(null);
      await load();
    } catch {
      setError("Network error — the course was not saved.");
    } finally {
      setSaving((n) => n - 1);
    }
  }

  /**
   * Ticks a session. The server returns the authoritative course, which
   * replaces the optimistic state — so a rejected or partial write can never
   * leave a tick showing that was not actually recorded.
   */
  async function toggle(course: AttendanceCourse, index: number) {
    setSaving((n) => n + 1);

    const before = course.missed;
    // Decide the desired state here and send it explicitly. The server then
    // performs one atomic add/remove instead of a read-flip-write, so two fast
    // ticks cannot overwrite each other and a retry is harmless.
    const absent = !before.includes(index);
    const optimistic = absent
      ? [...before, index].sort((a, b) => a - b)
      : before.filter((i) => i !== index);

    setCourses((prev) => prev.map((c) => (c.id === course.id ? { ...c, missed: optimistic } : c)));

    try {
      const res = await attendanceApi(`/api/student/attendance-courses/${course.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ set: { index, absent } }),
      });
      const j = await res.json().catch(() => null);

      if (!res.ok) {
        // Put it back exactly as it was and say so loudly.
        setCourses((prev) => prev.map((c) => (c.id === course.id ? { ...c, missed: before } : c)));
        setError(j?.error ?? "That change was NOT saved. Check the box again.");
        return;
      }

      setCourses((prev) => prev.map((c) => (c.id === course.id ? (j.course as AttendanceCourse) : c)));
      setError(null);
    } catch {
      setCourses((prev) => prev.map((c) => (c.id === course.id ? { ...c, missed: before } : c)));
      setError("Network error — that change was NOT saved. Check the box again.");
    } finally {
      setSaving((n) => n - 1);
    }
  }

  async function removeCourse(course: AttendanceCourse) {
    if (!confirm(`Delete "${course.name}" and everything recorded against it?`)) return;

    setSaving((n) => n + 1);
    try {
      const res = await attendanceApi(`/api/student/attendance-courses/${course.id}`, { method: "DELETE" });
      if (!res.ok) {
        setError("Could not delete that course.");
        return;
      }
      await load();
    } catch {
      setError("Network error — nothing was deleted.");
    } finally {
      setSaving((n) => n - 1);
    }
  }

  return (
    <div className="space-y-6">
      {/*
        The whole point of this banner: the page is an arithmetic aid over
        numbers the student typed in themselves. It has no connection to the
        university's records and cannot know about excuses, cancelled sessions
        or corrections.
      */}
      <section
        role="alert"
        className="rounded-3xl border-2 border-risk/60 bg-risk/10 p-4 sm:p-8"
      >
        <div className="flex items-start gap-3 sm:gap-4">
          <TriangleAlert className="mt-1 h-8 w-8 shrink-0 text-risk sm:h-12 sm:w-12" />
          <div className="min-w-0 space-y-3">
            <h2 className="text-lg font-extrabold uppercase leading-tight tracking-tight text-risk sm:text-2xl md:text-4xl">
              Using this is your own responsibility
            </h2>
            <p className="text-base font-bold leading-snug sm:text-xl">
              If you get dropped because you did not calculate your attendance correctly, that is
              your responsibility — not CampusGuide&apos;s.
            </p>
            <p className="text-sm text-foreground/75 sm:text-base">
              These numbers come from what you typed in and the boxes you ticked. This page is not
              connected to the university&apos;s attendance records. Always confirm your real
              standing with your professor or student affairs before relying on it.
            </p>
          </div>
        </div>
      </section>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Attendance</h1>
          <p className="text-sm text-foreground/70">
            Tick a box for every session you missed — lectures and labs count together. You are
            barred past {MAX_ABSENCE_PERCENT}% absence; the allowance is rounded down.
          </p>
        </div>

        {/* Saving state is visible, because a silent failure here is the
            dangerous one. */}
        <p className="flex items-center gap-2 text-sm font-semibold">
          {saving > 0 ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin text-foreground/60" />
              <span className="text-foreground/60">Saving…</span>
            </>
          ) : error ? (
            <>
              <CloudOff className="h-4 w-4 text-risk" />
              <span className="text-risk">Not saved</span>
            </>
          ) : (
            <>
              <Cloud className="h-4 w-4 text-success" />
              <span className="text-success">Saved to your account</span>
            </>
          )}
        </p>
      </div>

      {error ? (
        <p className="rounded-2xl border border-risk/40 bg-risk/10 px-4 py-3 text-sm font-bold text-risk">
          {error}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Add a course</CardTitle>
          <CardDescription>
            Saving a name that already exists updates that course instead of creating a second one.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <label className="space-y-1.5 xl:col-span-2">
              <span className="text-sm font-semibold">Course name</span>
              <Input
                value={courseName}
                onChange={(e) => setCourseName(e.target.value)}
                placeholder="e.g. Digital Logic Design"
                maxLength={LIMITS.nameMax}
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-sm font-semibold">Weeks</span>
              <Input
                type="number"
                min={LIMITS.weeks.min}
                max={LIMITS.weeks.max}
                value={weeks}
                onChange={(e) => setWeeks(e.target.value)}
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-sm font-semibold">Lectures / week</span>
              <Input
                type="number"
                min={0}
                max={LIMITS.perWeek.max}
                value={lecturesPerWeek}
                onChange={(e) => setLecturesPerWeek(e.target.value)}
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-sm font-semibold">Labs / week</span>
              <Input
                type="number"
                min={0}
                max={LIMITS.perWeek.max}
                value={labsPerWeek}
                disabled={!hasLab}
                onChange={(e) => setLabsPerWeek(e.target.value)}
              />
            </label>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-4">
            <label className="flex cursor-pointer items-center gap-2.5 text-sm font-semibold">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={hasLab}
                onChange={(e) => setHasLab(e.target.checked)}
              />
              This course has labs
            </label>
            <Button onClick={addCourse} disabled={!courseName.trim() || saving > 0}>
              <Check className="h-4 w-4" />
              Save course
            </Button>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <p className="py-10 text-sm text-foreground/60">Loading your courses…</p>
      ) : courses.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-sm font-semibold">No courses yet.</p>
            <p className="mt-1 text-sm text-foreground/60">Add one above to start ticking sessions.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-5">
          {courses.map((course) => {
            // Lectures and labs share one allowance: 25% of all of them together.
            const s = summarizeCourse(course);

            // Sitting exactly on the allowance: not barred, but one more session
            // does it. Distinct from "1 left", which the badge used to conflate.
            const atMax = s.status !== "barred" && s.allowed > 0 && s.remaining === 0;

            return (
              <Card
                key={course.id}
                className={cn(
                  s.status === "barred" && "border-risk/50",
                  s.status === "warning" && "border-warning/40"
                )}
              >
                <CardHeader>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="flex flex-wrap items-center gap-2">
                        {course.name}
                        {/* The old label said "One left" for any warning state,
                            including zero remaining — it read "One left" on a
                            card that also said "0 more allowed". */}
                        {s.status === "barred" ? (
                          <Badge tone="risk">Over the limit</Badge>
                        ) : atMax ? (
                          <Badge tone="warning">Max absences</Badge>
                        ) : s.status === "warning" ? (
                          <Badge tone="warning">1 left</Badge>
                        ) : (
                          <Badge tone="success">Safe</Badge>
                        )}
                      </CardTitle>
                      <CardDescription>
                        {course.weeks} weeks · {course.lecturesPerWeek}/wk lectures
                        {course.hasLab ? ` · ${course.labsPerWeek}/wk labs` : ""}
                      </CardDescription>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="hover:text-risk"
                      onClick={() => removeCourse(course)}
                      disabled={saving > 0}
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </Button>
                  </div>
                </CardHeader>

                <CardContent className="space-y-6">
                  {s.status === "barred" ? (
                    <p className="flex items-center gap-2 rounded-xl border border-risk/40 bg-risk/10 px-4 py-3 text-sm font-bold text-risk">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      You are past {MAX_ABSENCE_PERCENT}% in this course. Speak to your professor.
                    </p>
                  ) : null}

                  <section className="space-y-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="text-sm font-extrabold uppercase tracking-wide text-foreground/70">
                        {course.hasLab ? "Absences · lectures + labs" : "Absences"}
                      </h3>
                      <p className="text-sm">
                        <span className="font-extrabold">{s.missed}</span>
                        <span className="text-foreground/55"> of {s.total} missed · </span>
                        <span className={cn("font-extrabold", s.barred ? "text-risk" : "text-success")}>
                          {s.barred ? "over the limit" : `${s.remaining} more allowed`}
                        </span>
                        <span className="text-foreground/55"> (max {s.allowed})</span>
                      </p>
                    </div>
                    <AbsenceGrid
                      total={courseSessions(course)}
                      allowed={s.allowed}
                      missed={course.missed}
                      disabled={saving > 0}
                      onToggle={(i) => toggle(course, i)}
                    />
                  </section>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
