import fs from "node:fs";
import { test as teardown } from "@playwright/test";
import {
  ADMIN_ACCOUNT,
  AUTH_DIR,
  STUDENT_ACCOUNT,
  closeDb,
  deleteAccount,
  type TestAccount,
} from "./helpers";

/**
 * Removes the two accounts the setup project created.
 *
 * Runs once after every browser project, rather than in an afterAll hook: the
 * journey spec is executed by both the desktop and the mobile project, so an
 * afterAll would delete the shared account out from under whichever project
 * happened to still be running.
 *
 * On CI the database is thrown away with the runner and this is belt and
 * braces; locally it is what stops e2e accounts piling up.
 */

teardown("remove the test accounts", async () => {
  for (const file of [STUDENT_ACCOUNT, ADMIN_ACCOUNT]) {
    if (!fs.existsSync(file)) continue;

    try {
      const account: TestAccount = JSON.parse(fs.readFileSync(file, "utf8"));
      await deleteAccount(account.email);
    } catch {
      // A malformed file is not worth failing the run over — the accounts are
      // disposable either way.
    }
  }

  await closeDb();
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
});
