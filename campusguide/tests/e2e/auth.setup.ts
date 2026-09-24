import fs from "node:fs";
import { test as setup } from "@playwright/test";
import {
  ADMIN_ACCOUNT,
  ADMIN_STATE,
  AUTH_DIR,
  STUDENT_ACCOUNT,
  STUDENT_STATE,
  closeDb,
  createAccount,
  signIn,
} from "./helpers";

/**
 * Signs in once per run and saves the cookies for every other spec to reuse.
 *
 * Not a convenience: sign-in is rate limited to ten attempts per minute per
 * address, and on a runner every request resolves to the same bucket. Logging
 * in inside each test spent that budget after eleven tests and the twelfth
 * failed on a timeout that looked like a broken login page. Authenticating once
 * and replaying the cookie keeps the whole suite to two sign-ins.
 */


setup("authenticate as a student", async ({ page }) => {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const student = await createAccount({ status: "active" });
  fs.writeFileSync(STUDENT_ACCOUNT, JSON.stringify(student));

  await signIn(page, student);
  await page.context().storageState({ path: STUDENT_STATE });
});

setup("authenticate as an admin", async ({ page }) => {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const admin = await createAccount({ role: "admin", status: "active" });
  fs.writeFileSync(ADMIN_ACCOUNT, JSON.stringify(admin));

  await signIn(page, admin);
  await page.context().storageState({ path: ADMIN_STATE });

  await closeDb();
});
