/**
 * The bcrypt work factor, in one place because four call sites hashing at
 * different costs would be a silent inconsistency nobody would notice.
 *
 * 10 rather than 12. bcrypt is deliberately slow and that time is pure,
 * uninterruptible CPU: measured on a dev machine, cost 12 is ~400ms per hash or
 * compare and cost 10 is ~100ms. On Vercel Fluid that time is billed as active
 * CPU on every sign-in and every registration, and it was a visible share of
 * the launch-week bill.
 *
 * 10 is bcrypt's own default and at or above the OWASP floor, so this is a
 * deliberate cost/security trade rather than a shortcut. Raise it if the threat
 * model changes; existing hashes are unaffected either way, because bcrypt
 * stores the cost inside each hash and `compare` reads it from there.
 */
export const BCRYPT_COST = 10;
