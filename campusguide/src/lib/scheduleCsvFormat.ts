/**
 * The shape of a schedule CSV, with no parser attached.
 *
 * `parseScheduleCsv` pulls in papaparse, and the map and calendar pages both
 * need these constants to render their import panel — which meant papaparse
 * shipped in both page bundles for a button most students never press. Keeping
 * the vocabulary here lets those pages import it statically and load the parser
 * itself only when a file is actually chosen.
 */

export type ScheduleImportRow = {
  title: string;
  type: "lecture" | "lab";
  dayOfWeek: "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
  startTime: string;
  endTime: string;
  roomCode?: string;
  professor?: string;
};

export type ScheduleCsvResult =
  | { ok: true; rows: ScheduleImportRow[]; skipped: number }
  | { ok: false; error: string };

/** Mirrors the `rows` cap in the import route; rejecting here gives a better message. */
export const SCHEDULE_CSV_MAX_ROWS = 200;

export const SCHEDULE_CSV_HEADERS = [
  "title",
  "type",
  "dayOfWeek",
  "startTime",
  "endTime",
  "roomCode",
  "professor",
] as const;

// Room codes here are real seeded rooms, so a student who imports the template
// unchanged sees pins on the map rather than an empty one.
export const SCHEDULE_CSV_TEMPLATE = `title,type,dayOfWeek,startTime,endTime,roomCode,professor
Data Structures,lecture,SA,09:00,10:30,204,Dr. Ahmed Hassan
Data Structures,lab,MO,11:00,13:00,LABK,Eng. Mona Saleh
Linear Algebra,lecture,TU,08:00,09:30,RC1,Dr. Sara Fouad
`;
