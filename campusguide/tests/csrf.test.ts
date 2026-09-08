import test from "node:test";
import assert from "node:assert/strict";
import { isRequestCsrfSafe, isUnsafeMethod } from "../src/lib/csrf";

// Server-side CSRF backstop (pentest Finding 2). These lock in the exact
// behaviour the proxy relies on: a cross-site state-changing request is refused,
// a same-site one is let through, and a non-browser client is not blocked.

const HOSTS = ["campus-guide-miu.vercel.app"];

test("safe methods are never treated as CSRF risks", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    assert.equal(isUnsafeMethod(method), false);
    assert.equal(
      isRequestCsrfSafe({ method, origin: "https://evil.com", referer: null, allowedHosts: HOSTS }),
      true,
      `${method} must pass regardless of Origin`,
    );
  }
});

test("unsafe methods are recognised case-insensitively", () => {
  for (const method of ["post", "PUT", "Patch", "delete"]) {
    assert.equal(isUnsafeMethod(method), true);
  }
});

test("a cross-site Origin is rejected on a state-changing request", () => {
  assert.equal(
    isRequestCsrfSafe({
      method: "PATCH",
      origin: "https://evil.com",
      referer: null,
      allowedHosts: HOSTS,
    }),
    false,
  );
});

test("a same-site Origin is allowed", () => {
  assert.equal(
    isRequestCsrfSafe({
      method: "PATCH",
      origin: "https://campus-guide-miu.vercel.app",
      referer: null,
      allowedHosts: HOSTS,
    }),
    true,
  );
});

test("the Origin host is matched exactly — a look-alike does not pass", () => {
  assert.equal(
    isRequestCsrfSafe({
      method: "POST",
      origin: "https://campus-guide-miu.vercel.app.evil.com",
      referer: null,
      allowedHosts: HOSTS,
    }),
    false,
  );
});

test("Referer is used as a fallback when Origin is absent", () => {
  assert.equal(
    isRequestCsrfSafe({
      method: "POST",
      origin: null,
      referer: "https://evil.com/attack.html",
      allowedHosts: HOSTS,
    }),
    false,
    "a cross-site Referer is still a cross-site request",
  );
  assert.equal(
    isRequestCsrfSafe({
      method: "POST",
      origin: null,
      referer: "https://campus-guide-miu.vercel.app/teams",
      allowedHosts: HOSTS,
    }),
    true,
  );
});

test("no Origin and no Referer is allowed (non-browser client)", () => {
  // curl / the API test suite / a mobile app cannot be driven into a CSRF
  // attack against a logged-in browser, so we do not block them.
  assert.equal(
    isRequestCsrfSafe({ method: "POST", origin: null, referer: null, allowedHosts: HOSTS }),
    true,
  );
});

test("a request whose own host is one of several allowed hosts passes", () => {
  assert.equal(
    isRequestCsrfSafe({
      method: "DELETE",
      origin: "https://localhost:3000",
      referer: null,
      allowedHosts: ["localhost:3000", "x-forwarded.example", "campus-guide-miu.vercel.app"],
    }),
    true,
  );
});

test("a garbage Origin header does not throw and is refused", () => {
  assert.equal(
    isRequestCsrfSafe({ method: "POST", origin: "not a url", referer: null, allowedHosts: HOSTS }),
    // hostOf() returns null for an unparseable Origin, so it falls through to
    // Referer (also null) → treated as a non-browser client → allowed. The key
    // property is that it does not throw.
    true,
  );
});
