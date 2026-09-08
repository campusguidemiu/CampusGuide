import crypto from "crypto";

/**
 * Password-reset tokens (pentest Finding 3: reset handled manually over WhatsApp).
 *
 * The manual process left no audit trail and made the developer a
 * social-engineering target. This replaces it with a self-service, token-based
 * flow whose security properties live here so they can be reasoned about and
 * unit-tested in one place:
 *
 *   - The token is 32 random bytes, URL-safe. Only its SHA-256 hash is stored,
 *     so a leak of the database does not hand out working reset links.
 *   - It is single-use: consuming it clears the stored hash.
 *   - It is short-lived (30 minutes).
 *   - Verification is constant-time to avoid leaking the hash by timing.
 *
 * Delivery of the link is a separate concern (see the routes): no SMTP is wired
 * up in this environment, so the flow is complete and secure but the channel
 * that carries the link to the student still has to be configured.
 */

export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

/** A fresh reset token: the raw value to send the user, and what to store. */
export function createResetToken(now: number = Date.now()): {
  token: string;
  tokenHash: string;
  expiresAt: Date;
} {
  const token = crypto.randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: hashResetToken(token),
    expiresAt: new Date(now + RESET_TOKEN_TTL_MS),
  };
}

export function hashResetToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Whether a presented token matches a stored hash and has not expired.
 * Constant-time on the hash comparison; false for any missing/blank input.
 */
export function isResetTokenValid(
  presented: string | null | undefined,
  storedHash: string | null | undefined,
  expiresAt: unknown,
  now: number = Date.now(),
): boolean {
  if (!presented || !storedHash) return false;

  const expiryMs =
    expiresAt instanceof Date
      ? expiresAt.getTime()
      : typeof expiresAt === "string"
        ? Date.parse(expiresAt)
        : typeof expiresAt === "number"
          ? expiresAt
          : NaN;
  if (Number.isNaN(expiryMs) || now >= expiryMs) return false;

  const presentedHash = Buffer.from(hashResetToken(presented), "hex");
  const stored = Buffer.from(storedHash, "hex");
  if (presentedHash.length !== stored.length) return false;

  return crypto.timingSafeEqual(presentedHash, stored);
}
