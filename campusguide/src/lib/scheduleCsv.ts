/**
 * Turns a schedule spreadsheet into rows for POST /api/student/schedule/import.
 *
 * Students export their timetable from Excel or Google Sheets, so the column
 * names and the way days and times are written vary a lot. Everything is
 * normalized here — once, in one place — so the calendar and the map importers
 * cannot disagree about what a valid CSV looks like.
 */
import Papa from "papaparse";
import { normalizeClockTime } from "./time";
import {
  SCHEDULE_CSV_HEADERS,
  SCHEDULE_CSV_MAX_ROWS,
  type ScheduleCsvResult,
  type ScheduleImportRow,
} from "./scheduleCsvFormat";

// Re-exported so importing the parser still hands you the whole vocabulary.
// Anything that needs only the constants should import ./scheduleCsvFormat
// directly - that is what keeps papaparse out of the page bundles.
export * from "./scheduleCsvFormat";

/** Header names people actually type, mapped to the field they mean. */
const HEADER_ALIASES: Record<string, keyof ScheduleImportRow> = {
  title: "title",
  course: "title",
  coursename: "title",
  subject: "title",
  class: "title",
  name: "title",

  type: "type",
  kind: "type",
  session: "type",
  sessiontype: "type",

  dayofweek: "dayOfWeek",
  day: "dayOfWeek",
  weekday: "dayOfWeek",

  starttime: "startTime",
  start: "startTime",
  from: "startTime",

  endtime: "endTime",
  end: "endTime",
  to: "endTime",
  finish: "endTime",

  roomcode: "roomCode",
  room: "roomCode",
  hall: "roomCode",
  location: "roomCode",
  venue: "roomCode",

  professor: "professor",
  prof: "professor",
  doctor: "professor",
  instructor: "professor",
  lecturer: "professor",
  teacher: "professor",
};

const DAYS: Record<string, ScheduleImportRow["dayOfWeek"]> = {
  mo: "MO", mon: "MO", monday: "MO",
  tu: "TU", tue: "TU", tues: "TU", tuesday: "TU",
  we: "WE", wed: "WE", weds: "WE", wednesday: "WE",
  th: "TH", thu: "TH", thur: "TH", thurs: "TH", thursday: "TH",
  fr: "FR", fri: "FR", friday: "FR",
  sa: "SA", sat: "SA", saturday: "SA",
  su: "SU", sun: "SU", sunday: "SU",
};

function canonicalKey(header: string) {
  return header.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

export function parseScheduleCsv(text: string): ScheduleCsvResult {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^\uFEFF/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => HEADER_ALIASES[canonicalKey(h)] ?? canonicalKey(h),
  });

  if (parsed.errors?.length) {
    return { ok: false, error: "This file could not be read as CSV. Check the header row and try again." };
  }

  const records = parsed.data ?? [];
  if (records.length === 0) {
    return { ok: false, error: "The file is empty." };
  }

  const columns = new Set(parsed.meta?.fields ?? []);
  const missing = (["title", "dayOfWeek", "startTime", "endTime"] as const).filter((f) => !columns.has(f));
  if (missing.length) {
    return {
      ok: false,
      error: `Missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Expected headers: ${SCHEDULE_CSV_HEADERS.join(", ")}.`,
    };
  }

  const rows: ScheduleImportRow[] = [];
  let skipped = 0;

  for (const [index, record] of records.entries()) {
    // +2 so the number matches what the student sees in their spreadsheet,
    // where row 1 is the header.
    const lineNo = index + 2;
    const title = String(record.title ?? "").trim();

    // A trailing blank line or a spacer row is not worth an error.
    if (!title) {
      skipped += 1;
      continue;
    }

    const day = DAYS[String(record.dayOfWeek ?? "").trim().toLowerCase()];
    if (!day) {
      return { ok: false, error: `Row ${lineNo} ("${title}"): "${record.dayOfWeek ?? ""}" is not a day. Use MO, TU, WE, TH, FR, SA or SU.` };
    }

    const startTime = normalizeClockTime(record.startTime);
    const endTime = normalizeClockTime(record.endTime);
    if (!startTime || !endTime) {
      return { ok: false, error: `Row ${lineNo} ("${title}"): start and end times must be 24-hour HH:MM, e.g. 09:00 and 10:30.` };
    }
    if (endTime <= startTime) {
      return { ok: false, error: `Row ${lineNo} ("${title}"): the end time must be after the start time.` };
    }

    const roomCode = String(record.roomCode ?? "").trim().toUpperCase();
    const professor = String(record.professor ?? "").trim();

    rows.push({
      title: title.slice(0, 120),
      type: String(record.type ?? "").trim().toLowerCase().startsWith("lab") ? "lab" : "lecture",
      dayOfWeek: day,
      startTime,
      endTime,
      roomCode: roomCode ? roomCode.slice(0, 16) : undefined,
      professor: professor ? professor.slice(0, 100) : undefined,
    });
  }

  if (rows.length === 0) {
    return { ok: false, error: "No rows with a course title were found. Check that the first row holds the column names." };
  }

  if (rows.length > SCHEDULE_CSV_MAX_ROWS) {
    return { ok: false, error: `That file has ${rows.length} classes. Import at most ${SCHEDULE_CSV_MAX_ROWS} at a time.` };
  }

  return { ok: true, rows, skipped };
}
