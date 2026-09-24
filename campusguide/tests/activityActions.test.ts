import test from "node:test";
import assert from "node:assert/strict";
import { ActivityActions } from "../src/lib/activityActions";

/**
 * The activity log vocabulary.
 *
 * These strings are written into the database and then filtered on by the admin
 * activity page. Two names sharing a value silently merges two different events
 * in the audit trail, and renaming one orphans every row already written under
 * the old name — neither shows up as a type error.
 */

const entries = Object.entries(ActivityActions) as Array<[string, string]>;
const values = entries.map(([, value]) => value);

test("every action value is unique", () => {
  const seen = new Map<string, string>();
  for (const [name, value] of entries) {
    const clash = seen.get(value);
    assert.equal(clash, undefined, `${name} and ${clash} both use "${value}"`);
    seen.set(value, name);
  }
});

test("action values use the dotted namespace convention", () => {
  for (const [name, value] of entries) {
    assert.match(value, /^[a-z]+(\.[a-z_]+)+$/, `${name} = "${value}" breaks the convention`);
  }
});

test("every action is namespaced under a known area", () => {
  const areas = new Set(["auth", "abuse", "admin", "resource", "folder", "schedule", "team", "security", "video"]);
  for (const [name, value] of entries) {
    const area = value.split(".")[0];
    assert.ok(areas.has(area), `${name} uses unknown area "${area}"`);
  }
});

test("the security-critical auth actions keep their exact stored values", () => {
  // Renaming any of these breaks the brute-force alert queries and hides every
  // historical row from the admin filter.
  assert.equal(ActivityActions.SignIn, "auth.signin");
  assert.equal(ActivityActions.SignInFailed, "auth.signin.failed");
  assert.equal(ActivityActions.SignInUnknown, "auth.signin.unknown");
  assert.equal(ActivityActions.SignInBanned, "auth.signin.banned");
  assert.equal(ActivityActions.RateLimited, "abuse.rate_limited");
});

test("the password-reset actions keep their exact stored values", () => {
  assert.equal(ActivityActions.PasswordResetRequest, "auth.password_reset.request");
  assert.equal(ActivityActions.PasswordResetComplete, "auth.password_reset.complete");
});

test("a bulk purge is a distinct action from a single delete", () => {
  // The mass-deletion alert counts single deletes. If a purge logged as a
  // delete, one intentional cleanup would raise an alert against the admin who
  // pressed the button.
  assert.notEqual(ActivityActions.TeamPostPurge, ActivityActions.TeamPostDelete);
});

test("failed sign-ins are distinguishable from successful ones", () => {
  for (const failure of [
    ActivityActions.SignInFailed,
    ActivityActions.SignInUnknown,
    ActivityActions.SignInBanned,
  ]) {
    assert.notEqual(failure, ActivityActions.SignIn);
  }
});

test("no action name is left empty", () => {
  for (const [name, value] of entries) {
    assert.ok(value.length > 0, `${name} has an empty value`);
  }
});

test("the catalog covers each area the app logs to", () => {
  const areas = new Set(values.map((v) => v.split(".")[0]));
  for (const required of ["auth", "admin", "resource", "team", "security", "video"]) {
    assert.ok(areas.has(required), `nothing logs under "${required}" any more`);
  }
});
