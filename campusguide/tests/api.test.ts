/**
 * End-to-end API tests against a running server.
 *
 *   npx next start -p 3100      (or: npm run dev -- -p 3100)
 *   BASE_URL=http://localhost:3100 npx tsx --test tests/api.test.ts
 *
 * Uses a throwaway account per run and cleans up after itself.
 *
 * Start a FRESH server for each run: the rate limiter is in-process, and this
 * suite intentionally spends the registration budget down to the last request.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL ?? "http://localhost:3100";

/**
 * Lazy, shared Mongo handle. A couple of tests have to change data the API
 * deliberately won't expose — approving an account, for instance — and the
 * cleanup block uses the same connection.
 */
let mongooseRef: typeof import("mongoose") | null = null;

async function getDb() {
  if (!mongooseRef) {
    mongooseRef = (await import("mongoose")).default as unknown as typeof import("mongoose");
    const uri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/campusguide";
    await mongooseRef.connect(uri, { dbName: "campusguide" });
  }
  return mongooseRef.connection.db!;
}

async function closeDb() {
  if (mongooseRef) await mongooseRef.disconnect();
  mongooseRef = null;
}

const stamp = Date.now();
// Registration is MIU-only: the ID is 20xx/xxxxx and the university email has to
// embed the last two year digits plus that serial. The last five digits of the
// clock keep runs unique.
const MIU_SERIAL = String(stamp).slice(-5);
const MIU_ID = `2024/${MIU_SERIAL}`;
const EMAIL = `cgtest24${MIU_SERIAL}@miuegypt.edu.eg`;
const PHONE = `010${String(stamp).slice(-8)}`;
const PASSWORD = "TestPass123";
// Must match the server's ACCOUNT_STATE_TTL_MS; the verification test waits it out.
const STATE_TTL_MS = Number(process.env.ACCOUNT_STATE_TTL_MS ?? 30_000);

/** Cookie jar: next-auth needs the CSRF + session cookies carried across requests. */
const jar = new Map<string, string>();

function cookieHeader() {
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function storeCookies(res: Response) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (value) jar.set(name, value);
    else jar.delete(name);
  }
}

async function api(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  const cookies = cookieHeader();
  if (cookies) headers.set("cookie", cookies);
  const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
  storeCookies(res);
  return res;
}

async function json(res: Response) {
  return res.json().catch(() => null);
}

async function login() {
  const csrfRes = await api("/api/auth/csrf");
  const { csrfToken } = await json(csrfRes);

  const body = new URLSearchParams({
    csrfToken,
    email: EMAIL,
    password: PASSWORD,
    callbackUrl: `${BASE}/dashboard`,
    json: "true",
  });

  const res = await api("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return res;
}

before(async () => {
  // Fail fast with a useful message if nobody started the server.
  try {
    await fetch(`${BASE}/api/auth/csrf`);
  } catch {
    throw new Error(`No server at ${BASE}. Start it with: npx next start -p 3100`);
  }
});

// ---------------------------------------------------------------- auth gate

test("unauthenticated student APIs return 401, not a redirect or a crash", async () => {
  for (const path of [
    "/api/student/events",
    "/api/student/map",
    "/api/student/midterms",
    "/api/student/resources",
    "/api/student/attendance",
  ]) {
    const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
    assert.equal(res.status, 401, `${path} should be 401`);
  }
});

test("unauthenticated admin APIs return 401", async () => {
  const res = await fetch(`${BASE}/api/admin/rooms`, { redirect: "manual" });
  assert.equal(res.status, 401);
});

test("unauthenticated page requests redirect to /login with a next param", async () => {
  const res = await fetch(`${BASE}/dashboard`, { redirect: "manual" });
  assert.equal(res.status, 307);
  const location = res.headers.get("location") ?? "";
  assert.ok(location.includes("/login"), `expected a /login redirect, got ${location}`);
  assert.ok(location.includes("next=%2Fdashboard"), `expected next param, got ${location}`);
});

test("public pages render without a session", async () => {
  for (const path of ["/", "/login", "/register"]) {
    const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
    assert.ok(res.status === 200, `${path} returned ${res.status}`);
  }
});

// ------------------------------------------------------------- registration

/**
 * /api/auth/register is deliberately limited to 5 requests per IP per minute,
 * so this block spends its budget precisely: 5 real calls, then one more that
 * must be throttled. Adding a call here will make the last test fail.
 */
function register(body: unknown) {
  return api("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** A valid MIU registration, with individual fields swapped out per test. */
function registration(overrides: Record<string, unknown> = {}) {
  return {
    name: "CG Test",
    miuId: MIU_ID,
    email: EMAIL,
    phone: PHONE,
    password: PASSWORD,
    academicYear: 2,
    // Required since the Terms screen landed: the API refuses anything without
    // an explicit true here, and consent is recorded on the account.
    acceptTerms: true,
    ...overrides,
  };
}

test("a new account can be registered", async () => {
  const res = await register(registration());
  assert.equal(res.status, 201);
  assert.equal((await json(res))?.status, "pending", "new accounts must start unverified");
});

test("registration is refused without an explicit terms acceptance", async () => {
  // The consent record is a legal artifact, so this must fail closed. Both a
  // missing field and a falsy one have to be rejected — `false` slipping past a
  // truthiness check is exactly how this kind of guard rots.
  //
  // Sent from its own address: the registration limiter allows five attempts per
  // minute per IP, and the tests below count on that budget being spent exactly.
  // Borrowing two of them here would throttle the wrong test.
  const fromElsewhere = (body: Record<string, unknown>) =>
    api("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.77" },
      body: JSON.stringify(body),
    });

  const missing = await fromElsewhere(registration({ acceptTerms: undefined }));
  assert.equal(missing.status, 400);

  const refused = await fromElsewhere(registration({ acceptTerms: false }));
  assert.equal(refused.status, 400);
});

test("registering the same ID twice returns 409, not 500", async () => {
  const res = await register(registration());
  assert.equal(res.status, 409);
  assert.match(String((await json(res))?.error), /already/i);
});

test("a short password is rejected with readable guidance, not zod internals", async () => {
  const res = await register(
    registration({ miuId: "2024/00011", email: "weak2400011@miuegypt.edu.eg", password: "short1A" })
  );
  assert.equal(res.status, 400);
  const message = String((await json(res))?.error);
  assert.match(message, /at least 8 characters/i);
  assert.ok(!/expected string/i.test(message), `raw validator text leaked to the user: "${message}"`);
});

test("a non-MIU email cannot register", async () => {
  const res = await register(registration({ miuId: "2024/00012", email: `outsider-${stamp}@gmail.com` }));
  assert.equal(res.status, 400);
  assert.match(String((await json(res))?.error), /miuegypt\.edu\.eg/i);
});

test("a malformed body is rejected as 400, not a 500", async () => {
  const res = await register("{ not json");
  assert.equal(res.status, 400);
});

test("registration is rate limited once the budget is spent", async () => {
  const res = await register(registration({ miuId: "2024/00013", email: "flood2400013@miuegypt.edu.eg" }));
  assert.equal(res.status, 429, "the 6th registration in a minute should be throttled");
});

test("an unverified account is signed in but locked out of the app", async () => {
  await login();

  const session = await json(await api("/api/auth/session"));
  assert.equal(session?.user?.email, EMAIL, "a pending student can still hold a session");

  // Guards read account status from the database, not the token.
  assert.equal((await api("/api/student/events")).status, 401, "pending accounts must not reach student data");

  const page = await api("/dashboard");
  assert.equal(page.status, 307);
  assert.match(String(page.headers.get("location")), /\/pending/, "they belong on the verification screen");
});

test("sign-in works once the account is verified", async () => {
  // Stands in for an admin approving the ID photo in the verification dashboard.
  const db = await getDb();
  await db
    .collection("users")
    .updateOne({ email: EMAIL }, { $set: { status: "active", verifiedAt: new Date() } });

  // A real approval goes through the admin API, which drops the cached account
  // state immediately. Poking the database directly skips that, so wait out the
  // cache window instead. Start the server with ACCOUNT_STATE_TTL_MS=1000 to
  // keep this quick — see the header comment.
  await new Promise((resolve) => setTimeout(resolve, STATE_TTL_MS + 500));

  await login();
  const res = await api("/api/auth/session");
  const session = await json(res);
  assert.equal(session?.user?.email, EMAIL);
  assert.equal(session?.user?.role, "student");
  assert.equal((await api("/api/student/events")).status, 200, "a verified student has full access");
});

// ------------------------------------------------------------------- events

let recurringId = "";

test("a student can create a recurring class", async () => {
  const res = await api("/api/student/schedule/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      rows: [
        { title: "Test Calculus", type: "lecture", dayOfWeek: "MO", startTime: "09:00", endTime: "11:00", roomCode: "c204", professor: "Dr Test" },
        { title: "Test Calculus", type: "lecture", dayOfWeek: "WE", startTime: "09:00", endTime: "11:00", roomCode: "c204" },
        { title: "Test Physics Lab", type: "lab", dayOfWeek: "TU", startTime: "13:00", endTime: "15:00" },
      ],
    }),
  });
  assert.equal(res.status, 200);
  assert.equal((await json(res))?.imported, 3);
});

test("import rejects an impossible clock time instead of rolling over the day", async () => {
  const res = await api("/api/student/schedule/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      rows: [{ title: "Bad Time", type: "lecture", dayOfWeek: "MO", startTime: "99:99", endTime: "23:00" }],
    }),
  });
  assert.equal(res.status, 400);
  assert.match(String((await json(res))?.error), /HH:MM/i);
});

test("import rejects an end time at or before the start time", async () => {
  for (const [startTime, endTime] of [["14:00", "09:00"], ["10:00", "10:00"]]) {
    const res = await api("/api/student/schedule/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows: [{ title: "Backwards", type: "lecture", dayOfWeek: "MO", startTime, endTime }] }),
    });
    assert.equal(res.status, 400, `${startTime}->${endTime} should be rejected`);
    assert.match(String((await json(res))?.error), /end time/i);
  }
});

test("the calendar expands a weekly series across the requested range", async () => {
  const start = new Date();
  const end = new Date(start.getTime() + 28 * 24 * 60 * 60 * 1000);
  const res = await api(
    `/api/student/events?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`
  );
  assert.equal(res.status, 200);
  const events = (await json(res))?.events ?? [];

  const calculus = events.filter((e: any) => e.title === "Test Calculus");
  assert.ok(calculus.length >= 6, `expected ~8 occurrences over 4 weeks, got ${calculus.length}`);
  for (const e of calculus) {
    assert.equal(e.extendedProps.isRecurring, true);
    assert.equal(e.extendedProps.roomCode, "C204", "room codes are upper-cased on import");
    assert.ok(new Date(e.end) > new Date(e.start), "end must be after start");
  }
  recurringId = calculus[0].extendedProps.baseId;
  assert.ok(recurringId);
});

test("an absurd calendar range is clamped rather than expanding forever", async () => {
  const start = new Date().toISOString();
  const res = await api(`/api/student/events?start=${encodeURIComponent(start)}&end=9999-12-31T00%3A00%3A00.000Z`);
  assert.equal(res.status, 200);
  const events = (await json(res))?.events ?? [];
  // 3 series over a 400-day cap is a few hundred events, nowhere near millions.
  assert.ok(events.length < 5000, `expected a clamped result, got ${events.length} events`);
});

test("the calendar rejects a malformed date range", async () => {
  const res = await api("/api/student/events?start=banana&end=also-banana");
  assert.equal(res.status, 400);
});

test("a class can be renamed and moved to another weekday", async () => {
  const res = await api(`/api/student/events/${recurringId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Renamed Calculus", dayOfWeek: "TH", startTime: "10:00", endTime: "12:00" }),
  });
  assert.equal(res.status, 200);

  const start = new Date();
  const end = new Date(start.getTime() + 14 * 24 * 60 * 60 * 1000);
  const list = await json(
    await api(`/api/student/events?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`)
  );
  const renamed = (list?.events ?? []).filter((e: any) => e.title === "Renamed Calculus");
  assert.ok(renamed.length > 0, "the renamed series should still expand");
  for (const e of renamed) {
    assert.equal(new Date(e.start).getDay(), 4, "every occurrence should now be a Thursday");
    assert.equal(new Date(e.start).getHours(), 10);
  }
});

test("PATCH rejects an end time before the start time", async () => {
  const res = await api(`/api/student/events/${recurringId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ startTime: "15:00", endTime: "09:00" }),
  });
  assert.equal(res.status, 400);
});

test("PATCH rejects unknown fields and malformed ids", async () => {
  const strict = await api(`/api/student/events/${recurringId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: "000000000000000000000000" }),
  });
  assert.equal(strict.status, 400, "a strict schema must reject userId");

  const badId = await api("/api/student/events/not-an-object-id", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "x" }),
  });
  assert.equal(badId.status, 400);
});

test("a student cannot touch another user's event", async () => {
  const foreignId = "0123456789abcdef01234567";
  const res = await api(`/api/student/events/${foreignId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "hijacked" }),
  });
  assert.equal(res.status, 404);
});

test("clearing a room code actually removes it", async () => {
  const patch = await api(`/api/student/events/${recurringId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomCode: "", professor: "" }),
  });
  assert.equal(patch.status, 200);

  const start = new Date();
  const end = new Date(start.getTime() + 14 * 24 * 60 * 60 * 1000);
  const list = await json(
    await api(`/api/student/events?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`)
  );
  const renamed = (list?.events ?? []).find((e: any) => e.extendedProps.baseId === recurringId);
  assert.ok(renamed);
  assert.equal(renamed.extendedProps.roomCode, null, "an emptied room code must be unset, not \"\"");
});

// --------------------------------------------------------------- attendance

test("attendance groups duplicate series instead of double-counting absences", async () => {
  // "Test Calculus" was imported as two documents (MO + WE) sharing one key.
  const before = await json(await api("/api/student/attendance"));
  const labKey = (before?.series ?? []).find((s: any) => s.title === "Test Physics Lab")?.key;
  assert.ok(labKey, "the lab series should be present");

  const keys = (before?.series ?? []).map((s: any) => s.key);
  assert.equal(new Set(keys).size, keys.length, "each series key must appear only once");

  const patch = await api("/api/student/attendance", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: labKey, missedCount: 3 }),
  });
  assert.equal(patch.status, 200);

  const after = await json(await api("/api/student/attendance"));
  assert.equal(after?.summary?.missedSessions, 3, "3 missed sessions must not be counted twice");
});

test("attendance rejects a negative missed count", async () => {
  const res = await api("/api/student/attendance", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "lecture:whatever", missedCount: -5 }),
  });
  assert.equal(res.status, 400);
});

// ----------------------------------------------------------------- midterms

test("saving the same subject twice keeps the data instead of wiping it", async () => {
  const res = await api("/api/student/midterms", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      items: [
        { subject: "Calculus", midtermMark: 30, creditHours: 3 },
        { subject: "calculus", midtermMark: 35, creditHours: 3 },
        { subject: "Physics", midtermMark: 22, creditHours: 4 },
      ],
    }),
  });
  assert.equal(res.status, 200, "a duplicate subject used to 500 after deleting everything");

  const items = (await json(await api("/api/student/midterms")))?.items ?? [];
  assert.equal(items.length, 2, "duplicates collapse, other subjects survive");
  assert.ok(items.some((i: any) => i.subject.toLowerCase() === "physics"));
});

test("midterm marks outside 0-40 are rejected", async () => {
  for (const midtermMark of [-1, 41, 1000]) {
    const res = await api("/api/student/midterms", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ subject: "Bad", midtermMark }] }),
    });
    assert.equal(res.status, 400, `mark ${midtermMark} should be rejected`);
  }
});

test("previously saved midterms survive a rejected save", async () => {
  const items = (await json(await api("/api/student/midterms")))?.items ?? [];
  assert.equal(items.length, 2, "a 400 must not have deleted the stored grades");
});

// ---------------------------------------------------------------------- map

test("the map returns rooms, schedule codes and expanded upcoming classes", async () => {
  const res = await api("/api/student/map");
  assert.equal(res.status, 200);
  const j = await json(res);
  assert.ok(Array.isArray(j?.rooms));
  assert.ok(Array.isArray(j?.upcoming));
  assert.ok(Array.isArray(j?.scheduleRoomCodes));
  for (const u of j.upcoming) assert.ok(new Date(u.end) > new Date(u.start));
});

// ---------------------------------------------------------------- resources

test("resources reject an invalid filter and accept valid ones", async () => {
  assert.equal((await api("/api/student/resources?academicYear=9")).status, 400);
  assert.equal((await api("/api/student/resources?type=bogus")).status, 400);
  assert.equal((await api("/api/student/resources?academicYear=2&type=pdf")).status, 200);
});

test("every resource link is an absolute http(s) URL", async () => {
  const items = (await json(await api("/api/student/resources")))?.items ?? [];
  for (const it of items) {
    if (!it.externalUrl) continue;
    assert.match(it.externalUrl, /^https?:\/\//, `"${it.externalUrl}" would resolve relative to the page`);
  }
});

// ------------------------------------- attendance: lectures + labs pooled

/** What the Attendance page sends on every call; requests without it are refused. */
function attendanceApi(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-attendance-version", "2");
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return api(path, { ...init, headers });
}

function saveCourse(body: Record<string, unknown>) {
  return attendanceApi("/api/student/attendance-courses", { method: "POST", body: JSON.stringify(body) });
}

function tick(id: string, index: number, absent = true) {
  return attendanceApi(`/api/student/attendance-courses/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ set: { index, absent } }),
  });
}

async function studentId() {
  const user = await (await getDb()).collection("users").findOne({ email: EMAIL });
  assert.ok(user, "the test student exists");
  return user!._id;
}

/** A course stored exactly as the previous version stored it: two lists, no `missed`. */
async function insertLegacyCourse(name: string, missedLectures: unknown[], missedLabs: unknown[]) {
  const db = await getDb();
  const now = new Date();
  const { insertedId } = await db.collection("attendancecourses").insertOne({
    userId: await studentId(),
    name,
    weeks: 12,
    lecturesPerWeek: 2,
    hasLab: true,
    labsPerWeek: 1,
    missedLectures,
    missedLabs,
    createdAt: now,
    updatedAt: now,
    __v: 0,
  });
  return insertedId;
}

const DLD_SHAPE = { weeks: 12, lecturesPerWeek: 2, hasLab: true, labsPerWeek: 1 };
const upTo = (n: number) => Array.from({ length: n }, (_, i) => i);

test("the attendance-courses endpoint is live again, not the 410 it used to be", async () => {
  // This was retired once and asserted to answer 410. The attendance rewrite
  // brought it back — the page now loads, creates, updates and deletes through
  // it — so a 410 here would mean attendance is broken, not tidy.
  const res = await attendanceApi("/api/student/attendance-courses");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray((await json(res))?.courses), "the page expects a courses array");
});

test("a tab opened before the pooling is told to reload, and nothing is read or written", async () => {
  // No version header: exactly what a page loaded before the deploy sends.
  const get = await api("/api/student/attendance-courses");
  assert.equal(get.status, 409);
  assert.match((await json(get))?.error ?? "", /reload/i);

  const id = (await json(await saveCourse({ name: "Stale Tab", ...DLD_SHAPE })))?.course?.id;
  assert.ok(id);

  const oldTick = await api(`/api/student/attendance-courses/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ set: { kind: "lab", index: 0, absent: true } }),
  });
  assert.equal(oldTick.status, 409, "the old tick format is refused");

  // Even with the header, a lecture/lab `kind` is refused rather than half-applied.
  const withKind = await attendanceApi(`/api/student/attendance-courses/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ set: { kind: "lab", index: 0, absent: true } }),
  });
  assert.equal(withKind.status, 400);

  assert.equal((await api(`/api/student/attendance-courses/${id}`, { method: "DELETE" })).status, 409);

  const doc = await (await getDb())
    .collection("attendancecourses")
    .findOne({ userId: await studentId(), name: "Stale Tab" });
  assert.ok(doc, "the refused DELETE removed nothing");
  assert.deepEqual(doc!.missed, [], "the refused ticks wrote nothing");
});

test("lectures and labs are one pool: 12 weeks of 2 + 1 gives 36 boxes", async () => {
  const res = await saveCourse({ name: "Pool Test", ...DLD_SHAPE });
  assert.equal(res.status, 200);
  const course = (await json(res))?.course;
  assert.deepEqual(course.missed, []);
  assert.equal("missedLectures" in course, false, "the client never sees the old lists");

  const last = await tick(course.id, 35);
  assert.equal(last.status, 200, "box 36 of 36 exists");
  assert.deepEqual((await json(last))?.course?.missed, [35]);
  assert.equal((await tick(course.id, 36)).status, 400, "there is no box 37");

  await tick(course.id, 35); // the same box twice is still one absence
  assert.deepEqual((await json(await tick(course.id, 35, false)))?.course?.missed, []);

  const doc = await (await getDb())
    .collection("attendancecourses")
    .findOne({ userId: await studentId(), name: "Pool Test" });
  assert.deepEqual(doc!.missed, []);
  assert.equal(doc!.missedLectures, undefined, "new courses never get the old lists");
  assert.equal(doc!.missedLabs, undefined);
  assert.equal(doc!.mergedFrom, undefined, "nothing was merged into a new course");
});

test("re-saving a course keeps its absences and trims only boxes past the new size", async () => {
  const id = (await json(await saveCourse({ name: "Resave Test", ...DLD_SHAPE })))?.course?.id;
  for (const index of [0, 1, 2, 30]) assert.equal((await tick(id, index)).status, 200);

  // Same name, labs turned off: 24 boxes. Box 31 no longer exists; boxes 1-3 stay.
  const resaved = (await json(await saveCourse({ name: "Resave Test", ...DLD_SHAPE, hasLab: false, labsPerWeek: 0 })))?.course;
  assert.equal(resaved.id, id, "the same course was edited, not a second one created");
  assert.equal(resaved.hasLab, false);
  assert.deepEqual(resaved.missed, [0, 1, 2], "re-saving used to wipe these");

  const list = await json(await attendanceApi("/api/student/attendance-courses"));
  assert.deepEqual(list.courses.find((c: any) => c.id === id).missed, [0, 1, 2]);
});

test("clear unticks every box, and the old per-kind clear is refused", async () => {
  const id = (await json(await saveCourse({ name: "Clear Test", ...DLD_SHAPE })))?.course?.id;
  for (const index of [0, 1, 2]) await tick(id, index);

  const bad = await attendanceApi(`/api/student/attendance-courses/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ clear: "lecture" }),
  });
  assert.equal(bad.status, 400);

  const cleared = await attendanceApi(`/api/student/attendance-courses/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ clear: true }),
  });
  assert.deepEqual((await json(cleared))?.course?.missed, []);
});

test("a course saved the old way is shown pooled, and merged for real on its first tick", async () => {
  // Lecture ticks unsorted, the way $addToSet left them.
  await insertLegacyCourse("Legacy Test", [2, 0, 1], [0, 1]);
  const db = await getDb();
  const userId = await studentId();

  const shown = (await json(await attendanceApi("/api/student/attendance-courses")))?.courses?.find(
    (c: any) => c.name === "Legacy Test"
  );
  assert.deepEqual(shown.missed, [0, 1, 2, 3, 4], "3 lecture + 2 lab absences = 5");

  const afterRead = await db.collection("attendancecourses").findOne({ userId, name: "Legacy Test" });
  assert.equal(afterRead!.missed, undefined, "reading must not merge anything");

  const ticked = await json(await tick(shown.id, 5));
  assert.deepEqual(ticked?.course?.missed, [0, 1, 2, 3, 4, 5]);

  const merged = await db.collection("attendancecourses").findOne({ userId, name: "Legacy Test" });
  assert.deepEqual(merged!.missed, [0, 1, 2, 3, 4, 5]);
  assert.equal(merged!.mergedFrom.lectures, 3);
  assert.equal(merged!.mergedFrom.labs, 2);
  assert.ok(merged!.mergedFrom.at instanceof Date);
  assert.deepEqual(merged!.missedLectures, [2, 0, 1], "the old lists are kept exactly as they were");
  assert.deepEqual(merged!.missedLabs, [0, 1]);
});

test("re-saving a course saved the old way merges it and keeps every absence", async () => {
  await insertLegacyCourse("Legacy Resave", [0, 1, 2, 3], [0, 1]);

  const course = (await json(await saveCourse({ name: "Legacy Resave", ...DLD_SHAPE })))?.course;
  assert.deepEqual(course.missed, upTo(6), "4 lecture + 2 lab absences survive the save");

  const doc = await (await getDb())
    .collection("attendancecourses")
    .findOne({ userId: await studentId(), name: "Legacy Resave" });
  assert.deepEqual(doc!.missed, upTo(6));
  assert.deepEqual({ lectures: doc!.mergedFrom.lectures, labs: doc!.mergedFrom.labs }, { lectures: 4, labs: 2 });
});

test("ten ticks racing on an unmerged course merge it once and lose none of them", async () => {
  const _id = await insertLegacyCourse("Race Test", [0, 1], [0]);

  // The merge fills boxes 0-2; these ten land on 3-12, all at the same moment.
  const results = await Promise.all(upTo(10).map((i) => tick(String(_id), 3 + i)));
  for (const r of results) assert.equal(r.status, 200);

  const doc = await (await getDb()).collection("attendancecourses").findOne({ _id });
  assert.deepEqual(
    [...doc!.missed].sort((a: number, b: number) => a - b),
    upTo(13),
    "3 merged + 10 ticked: nothing lost, nothing doubled"
  );
  assert.deepEqual({ lectures: doc!.mergedFrom.lectures, labs: doc!.mergedFrom.labs }, { lectures: 2, labs: 1 });
});

test("the resource download redirect rejects a malformed id instead of crashing", async () => {
  assert.equal((await api("/api/student/resources/abc/download")).status, 400);
  assert.equal((await api("/api/student/resources/0123456789abcdef01234567/download")).status, 404);
});

// ------------------------------------------------------- admin authorization

test("a student is forbidden from admin APIs", async () => {
  for (const path of ["/api/admin/rooms", "/api/admin/resources"]) {
    const res = await api(path);
    assert.equal(res.status, 403, `${path} should be 403 for a student`);
  }
});

test("a student hitting an admin page is redirected, not left on a blank 307", async () => {
  const res = await api("/admin");
  assert.equal(res.status, 307);
  const location = res.headers.get("location");
  assert.ok(location, "a 307 without a Location header renders an empty page");
  assert.ok(location!.includes("/dashboard"), `expected /dashboard, got ${location}`);
});

test("a student cannot create rooms or resources", async () => {
  const room = await api("/api/admin/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomCode: "HACK", building: "H", floor: 1, x: 0.5, y: 0.5 }),
  });
  assert.equal(room.status, 403);

  const resource = await api("/api/admin/resources", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "x", subject: "y", academicYear: 1, type: "pdf", externalUrl: "https://e.com" }),
  });
  assert.equal(resource.status, 403);
});

// ------------------------------------------------------------------- pages

test("authenticated pages render", async () => {
  for (const path of [
    "/dashboard",
    "/calendar",
    "/map",
    "/resources",
    "/videos",
    "/faq",
    "/attendance",
    "/gpa/estimator",
    "/gpa/calculator",
  ]) {
    const res = await api(path);
    assert.equal(res.status, 200, `${path} returned ${res.status}`);
  }
});

test("the dashboard shows the upcoming class instead of an empty state", async () => {
  const html = await (await api("/dashboard")).text();
  assert.ok(
    html.includes("Renamed Calculus") || html.includes("Test Physics Lab"),
    "a student with a weekly schedule should see a next class"
  );
  assert.ok(!html.includes("No upcoming classes."), "recurring classes must reach the dashboard");
});

test("the dashboard GPA is not stuck at 0.00 for 0-40 marks", async () => {
  const html = await (await api("/dashboard")).text();
  const match = html.match(/(\d\.\d{2})[–-](\d\.\d{2})/);
  assert.ok(match, "expected a worst–best GPA range on the dashboard");
  assert.ok(Number(match![2]) > 0, `best-case GPA should be above zero, got ${match![2]}`);
});

// ------------------------------------------------------------------ cleanup

after(async () => {
  const db = await getDb();
  const user = await db.collection("users").findOne({ email: EMAIL });
  if (user) {
    for (const c of ["events", "attendances", "attendancecourses", "midtermgrades"]) {
      await db.collection(c).deleteMany({ userId: user._id });
    }
    await db.collection("users").deleteOne({ _id: user._id });
    await db.collection("activitylogs").deleteMany({ actorId: user._id });
  }
  await closeDb();
});
