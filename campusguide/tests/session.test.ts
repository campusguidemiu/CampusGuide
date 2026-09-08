import test from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_DEFAULT_DAYS,
  SESSION_MAX_AGE_SECONDS,
  SESSION_REMEMBER_DAYS,
  isSessionExpired,
  isSessionRevoked,
  sessionDays,
  sessionExpiryFrom,
} from "../src/lib/session";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-30T12:00:00.000Z").getTime();

test("the two session lengths are the ones the sign-in form promises", () => {
  assert.equal(SESSION_REMEMBER_DAYS, 14, "the checkbox label says 14 days");
  assert.equal(SESSION_DEFAULT_DAYS, 7, "unticked lasts a week");
});

test("session lifetimes stay within the security ceiling", () => {
  // Shortened from 50/20 after the pentest (Finding 1 / §7.1): a session token
  // is a bearer credential for student PII, so its lifetime is a security
  // property, not a convenience knob. Two weeks is the agreed ceiling — anyone
  // pushing it back up should have to change this test on purpose.
  assert.ok(SESSION_REMEMBER_DAYS <= 14, "a captured token must not live longer than two weeks");
  assert.ok(SESSION_DEFAULT_DAYS >= 1, "an unticked session should still survive a day");
  assert.ok(SESSION_REMEMBER_DAYS >= SESSION_DEFAULT_DAYS, "remembering must last longer, not less");
});

test("ticking the box picks the longer window", () => {
  assert.equal(sessionDays(true), SESSION_REMEMBER_DAYS);
  assert.equal(sessionDays(false), SESSION_DEFAULT_DAYS);
});

test("the stamped expiry is exactly the chosen number of days out", () => {
  assert.equal(sessionExpiryFrom(true, NOW) - NOW, SESSION_REMEMBER_DAYS * DAY_MS);
  assert.equal(sessionExpiryFrom(false, NOW) - NOW, SESSION_DEFAULT_DAYS * DAY_MS);
});

test("a session is live right up to its expiry and dead on it", () => {
  const expiry = sessionExpiryFrom(false, NOW);

  assert.equal(isSessionExpired(expiry, NOW), false, "valid the moment it is issued");
  assert.equal(isSessionExpired(expiry, expiry - 1), false, "still valid a millisecond before");
  assert.equal(isSessionExpired(expiry, expiry), true, "dead on the boundary");
  assert.equal(isSessionExpired(expiry, expiry + 1), true);
});

test("an unticked session outlives 6 days and does not reach 8", () => {
  const expiry = sessionExpiryFrom(false, NOW);
  assert.equal(isSessionExpired(expiry, NOW + 6 * DAY_MS), false, "must survive 6 days");
  assert.equal(isSessionExpired(expiry, NOW + 8 * DAY_MS), true);
});

test("a ticked session survives 13 days and not 15", () => {
  const expiry = sessionExpiryFrom(true, NOW);
  assert.equal(isSessionExpired(expiry, NOW + 13 * DAY_MS), false);
  assert.equal(isSessionExpired(expiry, NOW + 15 * DAY_MS), true);
});

test("a token with no expiry is left alone rather than treated as expired", () => {
  // Sessions issued before this shipped carry no stamp. Reading a missing value
  // as "expired" would sign every existing student out on deploy.
  assert.equal(isSessionExpired(undefined, NOW), false);
  assert.equal(isSessionExpired(null, NOW), false);
  assert.equal(isSessionExpired("not a number", NOW), false);
  assert.equal(isSessionExpired(Number.NaN, NOW), false);
});

test("the cookie ceiling matches the longest session, so a token never outlives it", () => {
  assert.equal(SESSION_MAX_AGE_SECONDS, SESSION_REMEMBER_DAYS * 24 * 60 * 60);
  assert.ok(
    SESSION_MAX_AGE_SECONDS * 1000 >= SESSION_DEFAULT_DAYS * DAY_MS,
    "the cookie must outlast the shorter window, never the other way round"
  );
});

// --- Server-side session revocation (pentest Finding 1) ---------------------

test("a session is not revoked when the account has never logged out", () => {
  // No cut-off recorded → the revocation check never fires, whatever the token.
  assert.equal(isSessionRevoked(NOW, null), false);
  assert.equal(isSessionRevoked(NOW, undefined), false);
});

test("a token minted before the logout cut-off is revoked", () => {
  const loggedOutAt = NOW;
  const tokenMintedEarlier = NOW - 60 * 1000; // one minute before logout
  assert.equal(isSessionRevoked(tokenMintedEarlier, loggedOutAt), true);
});

test("a fresh token minted after the cut-off is accepted", () => {
  const loggedOutAt = NOW;
  const tokenMintedLater = NOW + 60 * 1000; // signed back in after logging out
  assert.equal(isSessionRevoked(tokenMintedLater, loggedOutAt), false);
});

test("the one-second floor stops a login revoking its own token", () => {
  // The token is minted a few hundred ms before the DB write that stamps the
  // cut-off; without the floor the login would instantly invalidate itself.
  const mintedAt = NOW;
  const cutoffWrittenAt = NOW + 300;
  assert.equal(isSessionRevoked(mintedAt, cutoffWrittenAt), false);
});

test("a cut-off with an un-stampable (pre-deploy) token fails closed", () => {
  // Tokens minted before loginAt existed carry no mint time. If the user has
  // since logged out, we cannot prove the token predates the cut-off — so we
  // revoke it rather than trust it.
  assert.equal(isSessionRevoked(undefined, NOW), true);
  assert.equal(isSessionRevoked(null, NOW), true);
});

test("the cut-off is read equally from a Date, an ISO string, or ms", () => {
  const minted = NOW - 60 * 1000;
  assert.equal(isSessionRevoked(minted, new Date(NOW)), true);
  assert.equal(isSessionRevoked(minted, new Date(NOW).toISOString()), true);
  assert.equal(isSessionRevoked(minted, NOW), true);
});
