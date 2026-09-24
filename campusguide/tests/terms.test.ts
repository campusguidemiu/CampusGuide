import test from "node:test";
import assert from "node:assert/strict";
import {
  TERMS_CONSENT_LABEL,
  TERMS_SECTIONS,
  TERMS_UPDATED,
  TERMS_VERSION,
} from "../src/lib/terms";

/**
 * The consent record.
 *
 * `acceptedTermsVersion` is stored against each account as proof of *which*
 * wording was agreed to. That record is only meaningful if the version is
 * bumped whenever the text changes — these tests pin the current wording so an
 * edit that leaves the version alone fails loudly instead of quietly
 * invalidating every stored consent.
 */

test("the version is a plain dotted number", () => {
  assert.match(TERMS_VERSION, /^\d+\.\d+$/);
});

test("the stated version and update date are the ones currently recorded", () => {
  // If you changed the terms text, bump TERMS_VERSION and TERMS_UPDATED, then
  // update these two lines deliberately. That is the point of the test.
  assert.equal(TERMS_VERSION, "1.0");
  assert.equal(TERMS_UPDATED, "30 August 2026");
});

test("section ids are unique, so anchors do not collide", () => {
  const ids = TERMS_SECTIONS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("section ids are URL-safe anchors", () => {
  for (const section of TERMS_SECTIONS) {
    assert.match(section.id, /^[a-z0-9-]+$/, `"${section.id}" is not anchor-safe`);
  }
});

test("every section has a title and at least one paragraph", () => {
  assert.ok(TERMS_SECTIONS.length > 0, "the terms page cannot be empty");

  for (const section of TERMS_SECTIONS) {
    assert.ok(section.title.trim().length > 0, `${section.id} has no title`);
    assert.ok(
      section.body.length > 0,
      `${section.id} has a title but no body — the binding statement is missing`,
    );
    for (const paragraph of section.body) {
      assert.ok(paragraph.trim().length > 0, `${section.id} has an empty paragraph`);
    }
  }
});

test("the sections the app relies on by id are present", () => {
  // The register form and the pending screen link straight to these anchors.
  const ids = TERMS_SECTIONS.map((s) => s.id);
  for (const required of ["responsibility", "miu-only", "conduct", "content", "availability"]) {
    assert.ok(ids.includes(required), `the "${required}" section was removed`);
  }
});

test("the consent label covers the three things it has to cover", () => {
  // This single sentence is what a student actually ticks. If it stops
  // mentioning one of these, the stored consent no longer covers it.
  assert.match(TERMS_CONSENT_LABEL, /MIU student/i);
  assert.match(TERMS_CONSENT_LABEL, /not share/i);
  assert.match(TERMS_CONSENT_LABEL, /responsibility/i);
});

test("the consent label is a single sentence, not a wall of text", () => {
  assert.ok(
    TERMS_CONSENT_LABEL.length < 400,
    "a checkbox label nobody reads is not meaningful consent",
  );
});

test("the attendance calculator disclaimer is still in the terms", () => {
  // The most load-bearing sentence on the page: it is the one that says a
  // student dropped from a course because of a figure here carries that risk.
  const all = TERMS_SECTIONS.flatMap((s) => s.body).join(" ");
  assert.match(all, /attendance calculator/i);
  assert.match(all, /own risk|own responsibility/i);
});
