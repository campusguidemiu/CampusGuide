/**
 * How long a sign-in lasts.
 *
 * Two lengths, chosen by the "remember me" box on the sign-in form. The longer
 * one is also the hard ceiling: it is what the session cookie and the JWT are
 * issued for, and the shorter one is enforced inside the token. A cookie can
 * therefore outlive its own token, which is the safe direction — the token is
 * what every guard actually trusts.
 *
 * In `lib` so the form can label the checkbox with the same number the server
 * enforces, rather than the two drifting apart.
 */

/** Ticked: the longest a session may live. */
// Shortened from 50 days. A session token is a bearer credential for an account
// holding student PII, and 50 days was an excessive exposure window if one was
// ever captured (pentest Finding 1, §7.1). Two weeks is the ceiling now.
export const SESSION_REMEMBER_DAYS = 14;

/** Unticked: still generous, because students come back between lectures. */
export const SESSION_DEFAULT_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export function sessionDays(rememberMe: boolean): number {
  return rememberMe ? SESSION_REMEMBER_DAYS : SESSION_DEFAULT_DAYS;
}

/** Absolute moment a session issued now should stop being accepted. */
export function sessionExpiryFrom(rememberMe: boolean, now: number = Date.now()): number {
  return now + sessionDays(rememberMe) * DAY_MS;
}

/** Whether a token's own expiry has passed. Missing means "no extra limit". */
export function isSessionExpired(expiresAt: unknown, now: number = Date.now()): boolean {
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return false;
  return now >= expiresAt;
}

/**
 * Server-side session revocation (pentest Finding 1: token valid after logout).
 *
 * A JWT session is a self-contained bearer credential; clearing the cookie in
 * the browser on logout does nothing to a copy already captured. The fix is a
 * per-account cut-off, `sessionsValidFrom`, stamped whenever the user logs out
 * or resets their password. Every guarded request compares the moment its token
 * was minted (`loginAt`, stamped into the JWT at sign-in) against that cut-off,
 * and a token minted before it is refused — even though it is still
 * cryptographically valid and unexpired.
 *
 * Fails closed: if the account has a cut-off but the token carries no `loginAt`
 * (a token minted before this shipped), it is treated as revoked. The only way
 * a cut-off exists is that the user deliberately logged out or reset, so killing
 * an older, un-stampable token is the intended outcome, not a regression.
 *
 * Missing cut-off (the normal case — the user has never logged out) means the
 * session is never revoked by this check.
 */
export function isSessionRevoked(
  loginAt: unknown,
  sessionsValidFrom: unknown,
): boolean {
  const cutoff = toMillis(sessionsValidFrom);
  if (cutoff === null) return false; // no logout/reset has ever happened

  const minted = toMillis(loginAt);
  if (minted === null) return true; // fail closed: un-stampable token vs a real cut-off

  // A one-second floor absorbs the sub-second gap between minting the token and
  // the DB write, so a token is never killed by the very login that created it.
  return minted < cutoff - 1000;
}

/** Accepts a number of ms, an ISO string, or a Date. Anything else is null. */
function toMillis(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** Seconds, for NextAuth's `session.maxAge`, which is the outer bound. */
export const SESSION_MAX_AGE_SECONDS = SESSION_REMEMBER_DAYS * 24 * 60 * 60;

/**
 * Asked before signing out.
 *
 * Shared by the student navbar (desktop and drawer) and the admin sidebar —
 * three buttons that must not drift into three different questions.
 */
export const SIGN_OUT_CONFIRM = "Are you sure you want to sign out?";
