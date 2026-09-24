import path from "node:path";
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import type { Page } from "@playwright/test";

/**
 * Where the setup project saves its cookie jars.
 *
 * These live here rather than in auth.setup.ts because Playwright refuses to
 * let one test file import another, and both the specs and the teardown need
 * the paths.
 */
export const AUTH_DIR = path.join(__dirname, "..", "..", "playwright", ".auth");
export const STUDENT_STATE = path.join(AUTH_DIR, "student.json");
export const ADMIN_STATE = path.join(AUTH_DIR, "admin.json");
export const STUDENT_ACCOUNT = path.join(AUTH_DIR, "student.account.json");
export const ADMIN_ACCOUNT = path.join(AUTH_DIR, "admin.account.json");

/**
 * Test accounts, created straight in the database.
 *
 * Registering through the form would be a more faithful journey, but it is rate
 * limited to five per minute per address and on a runner every request shares
 * one bucket — two browser projects would spend the budget and the suite would
 * fail for a reason that has nothing to do with the code under test. The
 * registration path itself is covered end to end in `tests/api.test.ts`.
 */

const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/campusguide";

export type TestAccount = {
  email: string;
  password: string;
  miuId: string;
  name: string;
};

let connection: typeof mongoose | null = null;

async function db() {
  if (!connection) {
    connection = await mongoose.connect(MONGODB_URI, { dbName: "campusguide" });
  }
  return connection.connection.db!;
}

export async function closeDb() {
  if (connection) {
    await connection.disconnect();
    connection = null;
  }
}

/** A unique, internally consistent MIU identity — the email digits must match the ID. */
function identity(): { miuId: string; email: string } {
  // Five digits, so the pair satisfies validateMiuIdentity().
  const serial = String(Math.floor(Math.random() * 90000) + 10000);
  const year = "2024";
  return {
    miuId: `${year}/${serial}`,
    email: `e2e${year.slice(2)}${serial}@miuegypt.edu.eg`,
  };
}

export async function createAccount(
  options: { role?: "student" | "admin"; status?: "pending" | "active" | "banned" } = {},
): Promise<TestAccount> {
  const { miuId, email } = identity();
  const password = "E2ePassword123";
  const name = options.role === "admin" ? "E2E Admin" : "E2E Student";

  await (await db()).collection("users").insertOne({
    email,
    name,
    miuId,
    passwordHash: await bcrypt.hash(password, 10),
    role: options.role ?? "student",
    // Explicit rather than relying on the schema default: these documents are
    // inserted through the driver, which does not apply Mongoose defaults.
    status: options.status ?? "active",
    academicYear: 2,
    acceptedTermsAt: new Date(),
    acceptedTermsVersion: "1.0",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return { email, password, miuId, name };
}

export async function deleteAccount(email: string) {
  await (await db()).collection("users").deleteOne({ email });
}

/** Signs in through the real form and waits for the app to settle. */
export async function signIn(page: Page, account: TestAccount) {
  // "domcontentloaded", not the default "load": the CSP sets
  // `upgrade-insecure-requests`, which is right in production but means that on
  // an http origin the browser upgrades every <Link> prefetch to https and
  // those connections hang. The load event then never fires and a goto that
  // rendered perfectly well times out anyway.
  await page.goto("/login", { waitUntil: "domcontentloaded" });

  // The form uses controlled components with no name or id, so the stable
  // anchors are the autocomplete hint and the input type.
  await page.locator('input[autocomplete="username"]').first().fill(account.email);
  await page.locator('input[type="password"]').first().fill(account.password);
  await page.locator('button[type="submit"]').first().click();

  // NextAuth posts, then the client redirects. Waiting on the URL rather than a
  // fixed timeout keeps this fast when it works and clear when it does not.
  //
  // `waitUntil` matters as much as the predicate: the default waits for the
  // load event, which never fires here because `upgrade-insecure-requests`
  // leaves the destination page's prefetches hanging on an http origin. The
  // dashboard renders, the URL changes, and the wait would still time out.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 20_000,
    waitUntil: "domcontentloaded",
  });
}
