/**
 * One-time merge of attendance courses from the old two-list format
 * (`missedLectures` + `missedLabs`) into the pooled `missed` list.
 *
 * Lectures and labs now share one allowance — 25% of all the sessions
 * together — so each course's absences become one list. The merge itself is
 * `mergeLegacyTicks` in src/lib/attendance.ts, the same function the API uses
 * when it meets an unmerged course, so the two can never disagree.
 *
 * Per course, this guarantees:
 *  - the number of absences is exactly lecture absences + lab absences, as the
 *    old page showed them;
 *  - the old lists are never modified: they stay in the record, next to a
 *    `mergedFrom` stamp holding the two counts;
 *  - a course is merged at most once, and never over a change it did not see
 *    (guarded update, retried on conflict).
 *
 * Run from campusguide/, in this order:
 *
 *   npx tsx scripts/merge-attendance.ts
 *       Dry run. Prints before -> after for every course; writes nothing.
 *   npx tsx scripts/merge-attendance.ts --backup-to <dir>
 *       Exact copy of the collection, read back and checked.
 *   npx tsx scripts/merge-attendance.ts --apply --backup <dir> [--production]
 *       The merge. --production is required for anything but a local database.
 *   npx tsx scripts/merge-attendance.ts --verify --backup <dir>
 *       Re-reads every course and checks it against the backup.
 *
 * Deploy the code that reads `missed` BEFORE taking the backup: from then on
 * nothing writes the old lists, so the backup is exactly what gets merged.
 * --apply refuses to run if any unmerged course differs from the backup,
 * because that would mean the old code is still writing.
 *
 * Output never includes names or user ids; the per-course report with course
 * ids is written next to the backup.
 */
import path from "node:path";
import dns from "node:dns";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { ensureSrvDns } from "../src/server/dns";
import {
  mergeLegacyTicks,
  normalizeCourse,
  summarize,
  summarizeCourse,
  totalSessions,
} from "../src/lib/attendance";

const { EJSON } = mongoose.mongo.BSON;

const COLLECTION = "attendancecourses";
const BACKUP_FILE = "attendancecourses.canonical.json";
const MANIFEST_FILE = "_manifest.json";
const MAX_BACKUP_AGE_MS = 60 * 60 * 1000;

// A raw course document. The legacy lists are named so TypeScript can see a
// Doc is a LegacyCourse (mergeLegacyTicks' argument); every field stays `any`.
type Doc = Record<string, any> & {
  _id: mongoose.Types.ObjectId;
  missedLectures?: any;
  missedLabs?: any;
};
type Status = "safe" | "warning" | "barred";
const RANK: Record<Status, number> = { safe: 0, warning: 1, barred: 2 };

function getArg(name: string): string | undefined {
  const idx = process.argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (idx === -1) return undefined;
  const raw = process.argv[idx];
  if (raw.includes("=")) return raw.split("=").slice(1).join("=");
  return process.argv[idx + 1];
}

const hasFlag = (name: string) => process.argv.includes(name);
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

class Abort extends Error {}

/** Host list of a Mongo URI with any credentials removed. */
function hostsOf(uri: string) {
  const afterScheme = uri.replace(/^mongodb(\+srv)?:\/\//, "");
  const withoutCreds = afterScheme.includes("@") ? afterScheme.slice(afterScheme.lastIndexOf("@") + 1) : afterScheme;
  return withoutCreds.split(/[/?]/)[0];
}

function isLocal(uri: string) {
  if (uri.startsWith("mongodb+srv://")) return false;
  return hostsOf(uri)
    .split(",")
    .every((h) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(h));
}

/** System resolver first; public DNS when it refuses (it does on some networks). */
function lookup(hostname: string, options: any, callback: any) {
  dns.lookup(hostname, options, (err: any, address: any, family: any) => {
    if (!err) return callback(null, address, family);
    const resolver = new dns.Resolver();
    resolver.setServers(["8.8.8.8", "1.1.1.1"]);
    resolver.resolve4(hostname, (err2: any, addrs: string[]) => {
      if (err2 || !addrs?.length) return callback(err);
      if (options?.all) return callback(null, addrs.map((a) => ({ address: a, family: 4 })));
      callback(null, addrs[0], 4);
    });
  });
}

// ---------------------------------------------------------------- the plan

/** Before and after for one unmerged course. Computes only; writes nothing. */
function planFor(doc: Doc) {
  const merge = mergeLegacyTicks(doc);
  const shape = normalizeCourse({
    id: String(doc._id),
    name: String(doc.name ?? ""),
    weeks: doc.weeks,
    lecturesPerWeek: doc.lecturesPerWeek,
    hasLab: doc.hasLab,
    labsPerWeek: doc.labsPerWeek ?? 0,
  });
  const lectureTotal = totalSessions(shape.weeks, shape.lecturesPerWeek);
  const labTotal = shape.hasLab ? totalSessions(shape.weeks, shape.labsPerWeek) : 0;

  // The old page's verdict: each kind measured against its own 25%.
  const parts = [
    summarize(lectureTotal, range(merge.lectures)),
    ...(shape.hasLab ? [summarize(labTotal, range(merge.labs))] : []),
  ];
  const oldStatus: Status = parts.some((p) => p.barred)
    ? "barred"
    : parts.some((p) => !p.barred && p.allowed > 0 && p.remaining <= 1)
      ? "warning"
      : "safe";

  const pooled = summarizeCourse({ ...shape, missed: merge.missed });

  const problems: string[] = [];
  if (pooled.missed !== merge.lectures + merge.labs) problems.push("the pooled course would not hold every absence");
  if (oldStatus !== "barred" && pooled.barred) problems.push("would become barred");
  if (RANK[pooled.status] > RANK[oldStatus]) problems.push(`status would get worse (${oldStatus} -> ${pooled.status})`);

  // Stored ticks the old page did not count either (junk, duplicates, ticks past
  // the end). They stay uncounted; this only makes them visible.
  const storedLectures = Array.isArray(doc.missedLectures) ? doc.missedLectures.length : 0;
  const storedLabs = shape.hasLab && Array.isArray(doc.missedLabs) ? doc.missedLabs.length : 0;
  const uncounted = storedLectures - merge.lectures + (storedLabs - merge.labs);

  return { merge, shape, lectureTotal, labTotal, parts, oldStatus, pooled, problems, uncounted };
}

function row(n: number, p: ReturnType<typeof planFor>) {
  const s = p.shape;
  const kinds = `${s.weeks}w ${s.lecturesPerWeek}L${s.hasLab ? `+${s.labsPerWeek}B` : ""}`.padEnd(10);
  const before =
    `lectures ${p.merge.lectures}/${p.lectureTotal} (max ${p.parts[0].allowed})` +
    (s.hasLab ? ` + labs ${p.merge.labs}/${p.labTotal} (max ${p.parts[1].allowed})` : "");
  const after = `${p.pooled.missed}/${p.pooled.total} (max ${p.pooled.allowed})`;
  return `#${String(n).padStart(3)} | ${kinds} | ${before.padEnd(52)} -> ${after.padEnd(16)} | ${p.oldStatus} -> ${p.pooled.status}${
    p.uncounted ? ` | ${p.uncounted} stored tick(s) never counted, still not counted` : ""
  }${p.problems.length ? `  <-- ${p.problems.join("; ")}` : ""}`;
}

// ---------------------------------------------------------------- backups

function readBackup(dir: string) {
  const manifest = JSON.parse(readFileSync(path.join(dir, MANIFEST_FILE), "utf8"));
  const text = readFileSync(path.join(dir, BACKUP_FILE), "utf8");
  if (sha256(text) !== manifest.sha256) throw new Abort(`backup in ${dir} does not match its manifest checksum`);

  // Relaxed parse: numbers come back as plain numbers, comparable with what
  // the driver returns; ids and dates keep their types.
  const docs = EJSON.parse(text, { relaxed: true }) as Doc[];
  if (!Array.isArray(docs) || docs.length !== manifest.count) throw new Abort(`backup in ${dir} has the wrong count`);

  return { manifest, docs, byId: new Map(docs.map((d) => [String(d._id), d])) };
}

async function backupTo(coll: mongoose.mongo.Collection, dir: string, uri: string) {
  if (existsSync(dir)) throw new Abort(`refusing to overwrite ${dir}`);
  const docs = await coll.find({}).sort({ _id: 1 }).toArray();
  const text = EJSON.stringify(docs, undefined, 2, { relaxed: false });

  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, BACKUP_FILE), text, "utf8");
  const manifest = {
    takenAt: new Date().toISOString(),
    database: "campusguide",
    collection: COLLECTION,
    host: hostsOf(uri),
    count: docs.length,
    sha256: sha256(text),
  };
  writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), "utf8");

  // Read it back through the same path --apply and --verify will use.
  const back = readBackup(dir);
  if (readFileSync(path.join(dir, BACKUP_FILE), "utf8") !== text) throw new Abort("backup read-back differs");
  console.log(`backup: ${dir}`);
  console.log(`  ${back.docs.length} courses, sha256 ${manifest.sha256}`);
  console.log("  READ-BACK CHECK: OK");
}

// ---------------------------------------------------------------- modes

async function dryRun(coll: mongoose.mongo.Collection) {
  const docs = (await coll.find({}).sort({ _id: 1 }).toArray()) as Doc[];
  const unmerged = docs.filter((d) => d.missed === undefined);
  const malformed = docs.filter((d) => d.missed !== undefined && !Array.isArray(d.missed));

  console.log(`courses: ${docs.length} | already merged: ${docs.length - unmerged.length - malformed.length} | to merge: ${unmerged.length}`);

  const transitions = new Map<string, number>();
  const problems: string[] = [];
  let absences = 0;

  unmerged.forEach((doc, i) => {
    const p = planFor(doc);
    console.log(row(i + 1, p));
    const key = `${p.oldStatus} -> ${p.pooled.status}`;
    transitions.set(key, (transitions.get(key) ?? 0) + 1);
    absences += p.merge.lectures + p.merge.labs;
    if (p.problems.length) problems.push(`#${i + 1}: ${p.problems.join("; ")}`);
  });

  console.log(`absences to carry over: ${absences} (every one of them; none added, none dropped)`);
  console.log("status changes:");
  for (const [k, n] of [...transitions].sort()) console.log(`  ${String(n).padStart(4)}  ${k}`);

  for (const d of malformed) problems.push(`course ${d._id}: 'missed' is present but not a list`);
  if (problems.length) {
    console.log("NOT SAFE TO APPLY:");
    for (const p of problems) console.log(`  ${p}`);
    process.exitCode = 1;
  } else {
    console.log("DRY RUN: nothing was written. Safe to apply.");
  }
}

async function apply(coll: mongoose.mongo.Collection, backupDir: string) {
  const backup = readBackup(backupDir);
  const age = Date.now() - new Date(backup.manifest.takenAt).getTime();
  if (!(age >= 0 && age <= MAX_BACKUP_AGE_MS)) {
    throw new Abort(`the backup is ${Math.round(age / 60000)} minutes old; take a fresh one right before applying`);
  }

  const unmerged = (await coll.find({ missed: { $exists: false } }).sort({ _id: 1 }).toArray()) as Doc[];

  // Every course still in the old format must be in the backup and unchanged.
  // Anything else means the old code is still writing — stop before touching
  // a thing.
  for (const doc of unmerged) {
    const saved = backup.byId.get(String(doc._id));
    if (!saved) throw new Abort(`a course was created in the old format after the backup (${doc._id}) — is the old deployment still live?`);
    for (const field of ["weeks", "lecturesPerWeek", "hasLab", "labsPerWeek", "missedLectures", "missedLabs"]) {
      if (!isDeepStrictEqual(doc[field], saved[field])) {
        throw new Abort(`course ${doc._id} changed (${field}) since the backup — is the old deployment still live?`);
      }
    }
    const p = planFor(doc);
    if (p.problems.length) throw new Abort(`course ${doc._id}: ${p.problems.join("; ")}`);
  }

  console.log(`merging ${unmerged.length} course(s)…`);
  const report: Record<string, unknown>[] = [];
  const outcomes = new Map<string, number>();

  for (const original of unmerged) {
    let outcome = "";
    let merge = mergeLegacyTicks(original);

    for (let attempt = 0; attempt < 5 && !outcome; attempt++) {
      const doc = (await coll.findOne({ _id: original._id })) as Doc | null;
      if (!doc) {
        outcome = "deleted by the student meanwhile";
        break;
      }
      if (doc.missed !== undefined) {
        outcome = "merged by the app meanwhile";
        break;
      }

      merge = mergeLegacyTicks(doc);
      const res = await coll.updateOne(
        {
          _id: doc._id,
          missed: { $exists: false },
          missedLectures: doc.missedLectures === undefined ? { $exists: false } : doc.missedLectures,
          missedLabs: doc.missedLabs === undefined ? { $exists: false } : doc.missedLabs,
        },
        {
          $set: {
            missed: merge.missed,
            mergedFrom: { lectures: merge.lectures, labs: merge.labs, at: new Date() },
          },
        }
      );
      if (res.matchedCount === 1) outcome = attempt === 0 ? "merged" : "merged after a retry";
    }

    if (!outcome) throw new Abort(`course ${original._id} kept changing; stopped. Re-run --apply: merged courses are skipped.`);

    outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
    report.push({
      courseId: String(original._id),
      lectures: merge.lectures,
      labs: merge.labs,
      missed: merge.lectures + merge.labs,
      outcome,
    });
  }

  const file = path.join(backupDir, `merge-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2), "utf8");
  for (const [k, n] of outcomes) console.log(`  ${String(n).padStart(4)}  ${k}`);
  console.log(`report: ${file}`);
}

async function verify(coll: mongoose.mongo.Collection, backupDir: string) {
  const backup = readBackup(backupDir);
  const docs = (await coll.find({}).sort({ _id: 1 }).toArray()) as Doc[];
  const failures: string[] = [];
  const tally = { exact: 0, changedSinceMerge: 0, deletedSinceBackup: 0, newSinceBackup: 0 };
  const live = new Map(docs.map((d) => [String(d._id), d]));

  for (const doc of docs) {
    if (!Array.isArray(doc.missed)) failures.push(`${doc._id}: not merged`);
  }

  for (const saved of backup.docs) {
    const id = String(saved._id);
    const doc = live.get(id);
    if (!doc) {
      tally.deletedSinceBackup++;
      continue;
    }
    if (!Array.isArray(doc.missed)) continue; // already reported

    const hadOldLists = saved.missedLectures !== undefined || saved.missedLabs !== undefined;
    if (!hadOldLists) continue; // created after pooling: nothing was merged

    for (const field of ["missedLectures", "missedLabs"]) {
      if (!isDeepStrictEqual(doc[field], saved[field])) failures.push(`${id}: the old ${field} list was modified`);
    }

    const expected = mergeLegacyTicks(saved);
    if (doc.mergedFrom?.lectures !== expected.lectures || doc.mergedFrom?.labs !== expected.labs) {
      failures.push(`${id}: merged ${doc.mergedFrom?.lectures}+${doc.mergedFrom?.labs}, expected ${expected.lectures}+${expected.labs}`);
      continue;
    }

    const now = [...doc.missed].sort((a: number, b: number) => a - b);
    if (isDeepStrictEqual(now, expected.missed)) {
      tally.exact++;
    } else if (doc.updatedAt instanceof Date && doc.updatedAt > doc.mergedFrom.at) {
      // The student has ticked or unticked since; the stamp above proves what
      // the merge itself wrote.
      tally.changedSinceMerge++;
    } else {
      failures.push(`${id}: holds ${now.length} absences, the merge wrote ${expected.missed.length}, and nothing has touched it since`);
    }
  }

  for (const doc of docs) if (!backup.byId.has(String(doc._id))) tally.newSinceBackup++;

  console.log(`courses now: ${docs.length} | in the backup: ${backup.docs.length}`);
  console.log(`  exactly as merged:                  ${tally.exact}`);
  console.log(`  ticked by the student since merging: ${tally.changedSinceMerge}`);
  console.log(`  created after the backup:            ${tally.newSinceBackup}`);
  console.log(`  deleted by the student since:        ${tally.deletedSinceBackup}`);

  if (failures.length) {
    console.log("VERIFY: FAILED");
    for (const f of failures) console.log(`  ${f}`);
    process.exitCode = 1;
  } else {
    console.log("VERIFY: OK — every course is merged, every count matches the backup, no old list was touched");
  }
}

// ---------------------------------------------------------------- main

async function main() {
  dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Abort("MONGODB_URI is not set. Put it in .env.local or your environment.");

  const mode = hasFlag("--apply") ? "apply" : hasFlag("--verify") ? "verify" : getArg("--backup-to") ? "backup" : "dry-run";
  console.log(`database: ${hostsOf(uri)} (${isLocal(uri) ? "local" : "REMOTE"}) | mode: ${mode}`);

  if (mode === "apply" && !isLocal(uri) && !hasFlag("--production")) {
    throw new Abort("this is not a local database; add --production to write to it");
  }
  const backupDir = getArg("--backup");
  if ((mode === "apply" || mode === "verify") && !backupDir) throw new Abort(`--${mode} needs --backup <dir>`);

  ensureSrvDns(uri);
  await mongoose.connect(uri, {
    dbName: "campusguide",
    serverSelectionTimeoutMS: 30_000,
    connectTimeoutMS: 30_000,
    lookup,
  } as mongoose.ConnectOptions);
  const coll = mongoose.connection.db!.collection(COLLECTION);

  if (mode === "dry-run") await dryRun(coll);
  if (mode === "backup") await backupTo(coll, path.resolve(getArg("--backup-to")!), uri);
  if (mode === "apply") await apply(coll, path.resolve(backupDir!));
  if (mode === "verify") await verify(coll, path.resolve(backupDir!));
}

main()
  .catch((err) => {
    console.error(err instanceof Abort ? `STOPPED, nothing more was written: ${err.message}` : err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
