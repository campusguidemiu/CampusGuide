import test from "node:test";
import assert from "node:assert/strict";
import { jsonWithEtag, noStoreJson } from "../src/server/httpCache";

/**
 * The ETag layer (commit "Refactor API responses to utilize ETags").
 *
 * Every student-facing GET now goes through `jsonWithEtag`, so a mistake here
 * is not a single wrong response — it is either every list endpoint losing its
 * conditional-request saving, or worse, one account being served another's
 * cached payload. The `vary: cookie` assertion below is the one guarding that.
 */

const reqWith = (headers: Record<string, string> = {}) =>
  new Request("https://campus-guide-miu.vercel.app/api/student/resources", { headers });

test("a fresh request gets 200, the body, and an ETag", async () => {
  const res = jsonWithEtag(reqWith(), { items: [1, 2, 3] });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.ok(res.headers.get("etag"), "an ETag must always be issued");
  assert.deepEqual(await res.json(), { items: [1, 2, 3] });
});

test("the ETag is quoted, as HTTP requires", () => {
  const etag = jsonWithEtag(reqWith(), { a: 1 }).headers.get("etag")!;
  // An unquoted ETag is silently ignored by some caches, which would turn the
  // whole feature into a no-op that still looks like it works.
  assert.match(etag, /^"[A-Za-z0-9+/=]+"$/);
});

test("the same body always produces the same ETag", () => {
  const a = jsonWithEtag(reqWith(), { items: [1, 2] }).headers.get("etag");
  const b = jsonWithEtag(reqWith(), { items: [1, 2] }).headers.get("etag");
  assert.equal(a, b);
});

test("a different body produces a different ETag", () => {
  const a = jsonWithEtag(reqWith(), { items: [1, 2] }).headers.get("etag");
  const b = jsonWithEtag(reqWith(), { items: [1, 3] }).headers.get("etag");
  assert.notEqual(a, b);
});

test("a matching If-None-Match returns 304 with no body", async () => {
  const etag = jsonWithEtag(reqWith(), { items: [1] }).headers.get("etag")!;

  const res = jsonWithEtag(reqWith({ "if-none-match": etag }), { items: [1] });

  assert.equal(res.status, 304);
  assert.equal(res.body, null, "a 304 must not carry a body");
  assert.equal(res.headers.get("etag"), etag, "the ETag is repeated on the 304");
});

test("a stale If-None-Match returns the new 200 body", async () => {
  const stale = jsonWithEtag(reqWith(), { items: [1] }).headers.get("etag")!;

  const res = jsonWithEtag(reqWith({ "if-none-match": stale }), { items: [1, 2] });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { items: [1, 2] });
});

test("If-None-Match with a list of tags matches any one of them", () => {
  const etag = jsonWithEtag(reqWith(), { items: [1] }).headers.get("etag")!;

  // Browsers send several tags when they hold more than one cached variant.
  const res = jsonWithEtag(
    reqWith({ "if-none-match": `"other", ${etag} , "another"` }),
    { items: [1] },
  );

  assert.equal(res.status, 304, "whitespace around a listed tag must still match");
});

test('If-None-Match: * always matches', () => {
  const res = jsonWithEtag(reqWith({ "if-none-match": "*" }), { items: [1] });
  assert.equal(res.status, 304);
});

test("responses vary on cookie, so one student's data is never served to another", () => {
  // These payloads are per-account and the cache key must include the session.
  // Without `vary: cookie` a shared cache can hand B the body it stored for A.
  for (const res of [
    jsonWithEtag(reqWith(), { items: [] }),
    jsonWithEtag(reqWith({ "if-none-match": "*" }), { items: [] }),
  ]) {
    assert.equal(res.headers.get("vary"), "cookie");
  }
});

test("the default cache-control forces revalidation and keeps it private", () => {
  const cc = jsonWithEtag(reqWith(), { a: 1 }).headers.get("cache-control")!;
  assert.match(cc, /private/);
  assert.match(cc, /must-revalidate/);
  assert.match(cc, /max-age=0/);
});

test("cache-control can be overridden per route", () => {
  const res = jsonWithEtag(reqWith(), { a: 1 }, { cacheControl: "public, max-age=300" });
  assert.equal(res.headers.get("cache-control"), "public, max-age=300");
});

test("a custom status is honoured on a fresh response", () => {
  assert.equal(jsonWithEtag(reqWith(), { id: "x" }, { status: 201 }).status, 201);
});

test("a 304 wins over a custom status", () => {
  // Returning 201 here would tell the client it created something when it did not.
  const etag = jsonWithEtag(reqWith(), { a: 1 }).headers.get("etag")!;
  const res = jsonWithEtag(reqWith({ "if-none-match": etag }), { a: 1 }, { status: 201 });
  assert.equal(res.status, 304);
});

test("an empty or absent If-None-Match never short-circuits", () => {
  const cases: Array<Record<string, string>> = [{}, { "if-none-match": "" }, { "if-none-match": " , , " }];
  for (const headers of cases) {
    assert.equal(jsonWithEtag(reqWith(headers), { a: 1 }).status, 200);
  }
});

test("key order changes the ETag — callers must serialize consistently", () => {
  // Documenting a real limitation rather than asserting a guarantee we don't
  // have: the hash is over JSON.stringify output, so a route that builds its
  // body with keys in a varying order will churn ETags and never hit a 304.
  const a = jsonWithEtag(reqWith(), { x: 1, y: 2 }).headers.get("etag");
  const b = jsonWithEtag(reqWith(), { y: 2, x: 1 }).headers.get("etag");
  assert.notEqual(a, b);
});

test("noStoreJson never caches and carries no ETag", async () => {
  const res = noStoreJson({ error: "nope" }, 403);

  assert.equal(res.status, 403);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("etag"), null, "a no-store response must not be revalidatable");
  assert.deepEqual(await res.json(), { error: "nope" });
});

test("noStoreJson defaults to 200", () => {
  assert.equal(noStoreJson({ ok: true }).status, 200);
});
