import test from "node:test";
import assert from "node:assert/strict";
import { MIN_SEARCH_LENGTH, SEARCH_DEBOUNCE_MS, searchTerm } from "../src/lib/search";

/**
 * Search-as-you-type gating on Resources and Teams.
 *
 * This is a bandwidth control, not a formatting helper: the whole point is that
 * the first keystroke returns the *same* value as an empty box, so the effect
 * depending on it never re-fires and that request is never made. A change that
 * makes single-character input return the character would silently restore the
 * per-keystroke request storm.
 */

test("a term at or over the minimum length is searched", () => {
  assert.equal(searchTerm("so"), "so");
  assert.equal(searchTerm("software"), "software");
});

test("a single character is not a search", () => {
  assert.equal(searchTerm("s"), "");
});

test("an empty or whitespace-only box is not a search", () => {
  for (const raw of ["", " ", "\t", "   \n  "]) {
    assert.equal(searchTerm(raw), "");
  }
});

test("typing the first character does not change the derived term", () => {
  // The property the debounce saving actually depends on.
  assert.equal(searchTerm(""), searchTerm("s"));
});

test("surrounding whitespace is trimmed before the length check", () => {
  assert.equal(searchTerm("  ab  "), "ab");
  assert.equal(searchTerm("  a  "), "", "padding must not push a 1-char query over the floor");
});

test("inner whitespace is preserved", () => {
  assert.equal(searchTerm("data structures"), "data structures");
});

test("the minimum length is respected exactly at the boundary", () => {
  const justUnder = "x".repeat(MIN_SEARCH_LENGTH - 1);
  const exactly = "x".repeat(MIN_SEARCH_LENGTH);

  assert.equal(searchTerm(justUnder), "");
  assert.equal(searchTerm(exactly), exactly);
});

test("the debounce stays at the tuned value", () => {
  // 400ms with a 2-character floor was measured against 250ms-from-first-char.
  // Lowering it is a real bandwidth regression, so it is pinned here.
  assert.equal(SEARCH_DEBOUNCE_MS, 400);
  assert.equal(MIN_SEARCH_LENGTH, 2);
});

test("non-latin queries are not penalised by the length rule", () => {
  // Arabic course names are two characters more often than English ones.
  assert.equal(searchTerm("رياضة"), "رياضة");
  assert.equal(searchTerm("ري"), "ري");
});
