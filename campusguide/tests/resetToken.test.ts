import test from "node:test";
import assert from "node:assert/strict";
import {
  RESET_TOKEN_TTL_MS,
  createResetToken,
  hashResetToken,
  isResetTokenValid,
} from "../src/lib/resetToken";

// Password-reset token security (pentest Finding 3).

test("a fresh token stores only its hash, never the token itself", () => {
  const { token, tokenHash } = createResetToken();
  assert.ok(token.length >= 40, "token should be long and random");
  assert.notEqual(token, tokenHash, "the stored value must not equal the token");
  assert.equal(tokenHash, hashResetToken(token), "stored value is the token's hash");
});

test("two tokens are never the same", () => {
  const a = createResetToken().token;
  const b = createResetToken().token;
  assert.notEqual(a, b);
});

test("the correct token within its window validates", () => {
  const now = Date.now();
  const { token, tokenHash, expiresAt } = createResetToken(now);
  assert.equal(isResetTokenValid(token, tokenHash, expiresAt, now), true);
});

test("a wrong token never validates against a stored hash", () => {
  const now = Date.now();
  const { tokenHash, expiresAt } = createResetToken(now);
  assert.equal(isResetTokenValid("someone-elses-token", tokenHash, expiresAt, now), false);
});

test("an expired token is rejected even if it is the right one", () => {
  const now = Date.now();
  const { token, tokenHash, expiresAt } = createResetToken(now);
  const afterExpiry = now + RESET_TOKEN_TTL_MS + 1;
  assert.equal(isResetTokenValid(token, tokenHash, expiresAt, afterExpiry), false);
});

test("missing inputs are rejected rather than throwing", () => {
  assert.equal(isResetTokenValid(null, "abc", Date.now() + 1000), false);
  assert.equal(isResetTokenValid("abc", null, Date.now() + 1000), false);
  assert.equal(isResetTokenValid("abc", "def", null), false);
  assert.equal(isResetTokenValid("", "", ""), false);
});
