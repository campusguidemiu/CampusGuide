/**
 * The address returned here keys the rate limiter and is matched against the IP
 * block list, so whoever controls it controls both. These cover the case that
 * made the old implementation unsafe: a caller sending their own
 * x-forwarded-for and getting a fresh bucket, or a clean record, per request.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { getRequestIp, getRequestIpFromBag } from "../src/server/security/requestIp";

const REAL = "203.0.113.7";
const SPOOFED = "1.2.3.4";

test("the platform header wins over anything the caller sent", () => {
  const headers = new Headers({
    "x-forwarded-for": `${SPOOFED}, ${REAL}`,
    "x-vercel-forwarded-for": REAL,
    "x-real-ip": REAL,
  });
  assert.equal(getRequestIp(headers), REAL);
});

test("a spoofed x-forwarded-for cannot displace x-real-ip", () => {
  const headers = new Headers({ "x-forwarded-for": SPOOFED, "x-real-ip": REAL });
  assert.equal(getRequestIp(headers), REAL);
});

test("falling back to x-forwarded-for takes the last hop, not the caller's text", () => {
  // What an appending proxy produces: the client's own value first, the address
  // it actually observed last. Reading [0] here is the whole vulnerability.
  const headers = new Headers({ "x-forwarded-for": `${SPOOFED}, 10.0.0.1, ${REAL}` });
  assert.equal(getRequestIp(headers), REAL);
  assert.notEqual(getRequestIp(headers), SPOOFED);
});

test("no forwarding headers yields the placeholder, which is never blockable", () => {
  assert.equal(getRequestIp(new Headers()), "unknown");
});

test("whitespace and empty entries do not produce a blank identity", () => {
  assert.equal(getRequestIp(new Headers({ "x-forwarded-for": `  ${REAL}  ` })), REAL);
  assert.equal(getRequestIp(new Headers({ "x-forwarded-for": " , , " })), "unknown");
  assert.equal(getRequestIp(new Headers({ "x-real-ip": "   " })), "unknown");
});

test("two callers behind different addresses never share a bucket", () => {
  const a = getRequestIp(new Headers({ "x-real-ip": REAL }));
  const b = getRequestIp(new Headers({ "x-real-ip": "198.51.100.9" }));
  assert.notEqual(a, b);
});

/* The NextAuth sign-in path reads a plain header bag, and it has to agree with
   the routes - a block enforced on one is useless if the other sees a different
   caller. */

test("the header bag resolves identically to real Headers", () => {
  const bag = { "x-forwarded-for": `${SPOOFED}, ${REAL}`, "x-real-ip": REAL };
  const headers = new Headers(bag);
  assert.equal(getRequestIpFromBag(bag), getRequestIp(headers));
  assert.equal(getRequestIpFromBag(bag), REAL);
});

test("the bag handles array values, which node gives for repeated headers", () => {
  assert.equal(getRequestIpFromBag({ "x-real-ip": [REAL, SPOOFED] }), REAL);
});

test("a missing or empty bag is the placeholder, not a crash", () => {
  assert.equal(getRequestIpFromBag(undefined), "unknown");
  assert.equal(getRequestIpFromBag({}), "unknown");
});

test("a spoofed forwarded-for cannot beat the platform header on the sign-in path", () => {
  const bag = { "x-forwarded-for": SPOOFED, "x-vercel-forwarded-for": REAL };
  assert.equal(getRequestIpFromBag(bag), REAL);
});
