import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FLAG_STATE,
  FLAG_CATALOG,
  FLAG_KEYS,
  FlagKeys,
  flagMeta,
  isFlagKey,
} from "../src/lib/flags";

/**
 * The kill-switch catalog.
 *
 * `flagMeta` ends in a non-null assertion, so a key that is in `FlagKeys` but
 * missing from `FLAG_CATALOG` is a runtime crash in the admin controls page
 * rather than a type error. These tests keep the two in step.
 */

test("every declared flag key has a catalog entry", () => {
  for (const key of Object.values(FlagKeys)) {
    const meta = FLAG_CATALOG.find((f) => f.key === key);
    assert.ok(meta, `${key} is declared but has no catalog entry — flagMeta() would throw`);
  }
});

test("the catalog contains no entries for undeclared keys", () => {
  const declared = new Set<string>(Object.values(FlagKeys));
  for (const entry of FLAG_CATALOG) {
    assert.ok(declared.has(entry.key), `${entry.key} is in the catalog but not in FlagKeys`);
  }
});

test("FLAG_KEYS is derived from the catalog and stays in sync", () => {
  assert.deepEqual([...FLAG_KEYS].sort(), FLAG_CATALOG.map((f) => f.key).sort());
});

test("flag keys are unique", () => {
  assert.equal(new Set(FLAG_KEYS).size, FLAG_KEYS.length);
});

test("flagMeta returns the matching entry", () => {
  const meta = flagMeta(FlagKeys.ResourcesLocked);
  assert.equal(meta.key, FlagKeys.ResourcesLocked);
  assert.equal(meta.label, "Lock the Resources drive");
});

test("every catalog entry is fully filled in", () => {
  // A blank defaultMessage means a student hits a locked area and is told
  // nothing at all about why.
  for (const entry of FLAG_CATALOG) {
    assert.ok(entry.label.trim().length > 0, `${entry.key} has no label`);
    assert.ok(entry.description.trim().length > 0, `${entry.key} has no description`);
    assert.ok(
      entry.defaultMessage.trim().length > 0,
      `${entry.key} has no default message to show students`,
    );
  }
});

test("isFlagKey accepts every real key", () => {
  for (const key of FLAG_KEYS) assert.equal(isFlagKey(key), true);
});

test("isFlagKey rejects anything else", () => {
  // This is the guard on the admin PATCH body; a false positive here would let
  // an arbitrary string be written into the flags collection.
  for (const bad of ["", "resources", "resources.lock", "RESOURCES.LOCKED", "__proto__", "toString"]) {
    assert.equal(isFlagKey(bad), false, `"${bad}" must not pass as a flag key`);
  }
});

test("flags default to off", () => {
  // The single most important property here: a missing database row must never
  // take an area of the app offline.
  assert.equal(DEFAULT_FLAG_STATE.enabled, false);
  assert.equal(DEFAULT_FLAG_STATE.message, null);
  assert.equal(DEFAULT_FLAG_STATE.updatedAt, null);
  assert.equal(DEFAULT_FLAG_STATE.updatedBy, null);
});

test("flag keys use the dotted namespace convention", () => {
  for (const key of FLAG_KEYS) {
    assert.match(key, /^[a-z]+(\.[a-z]+)+$/, `${key} should look like "area.thing"`);
  }
});
