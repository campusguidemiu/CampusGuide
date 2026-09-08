/**
 * Server-side CSRF backstop (pentest Finding 2: no server-side CSRF validation).
 *
 * The app was relying entirely on the session cookie's `SameSite=Lax` flag to
 * stop cross-site state-changing requests; the server itself checked nothing, so
 * a corrupted or missing NextAuth CSRF token still let a PATCH/POST through. The
 * report calls this a defence-in-depth failure: one browser-enforced control
 * with no server-side check behind it.
 *
 * This adds that server-side check, using the same technique Next.js applies to
 * Server Actions: on an unsafe method, the request's `Origin` (or, failing that,
 * `Referer`) must belong to the site itself. A browser attaches `Origin` to
 * every cross-site POST/PUT/PATCH/DELETE and cannot be told not to, so a forged
 * request from `evil.com` arrives with a foreign origin and is rejected before
 * it reaches any handler.
 *
 * Deliberately lenient when BOTH headers are absent: that is a non-browser
 * client (curl, a mobile app, the API test suite), which cannot be driven into
 * a CSRF attack against a logged-in browser session. The cookie's SameSite flag
 * remains the first line of defence for browsers; this is the backstop.
 *
 * Pure and dependency-free so it can be unit-tested without the Next runtime;
 * `src/proxy.ts` feeds it the request's headers.
 */

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isUnsafeMethod(method: string): boolean {
  return UNSAFE_METHODS.has(method.toUpperCase());
}

/** Lower-cased host (with port) parsed out of an Origin/Referer URL, or null. */
function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

export type CsrfInput = {
  method: string;
  origin: string | null | undefined;
  referer: string | null | undefined;
  /**
   * Every host that counts as "this site": the request's own Host header, any
   * `x-forwarded-host` the edge set, and the host of `NEXTAUTH_URL`. Compared
   * case-insensitively; blank entries are ignored.
   */
  allowedHosts: (string | null | undefined)[];
};

/**
 * Whether an unsafe request may proceed. Safe methods always may.
 *
 * Returns `false` only when a same-site claim is present (Origin or Referer) and
 * does NOT match the site — i.e. a genuine cross-origin state-changing request.
 */
export function isRequestCsrfSafe({ method, origin, referer, allowedHosts }: CsrfInput): boolean {
  if (!isUnsafeMethod(method)) return true;

  const allowed = new Set(
    allowedHosts
      .map((h) => (h ?? "").trim().toLowerCase())
      .filter((h) => h.length > 0),
  );
  // No idea what our own host is — cannot make a safe judgement, so do not block.
  if (allowed.size === 0) return true;

  const originHost = hostOf(origin);
  if (originHost !== null) return allowed.has(originHost);

  // No Origin (some same-origin navigations, older clients): fall back to Referer.
  const refererHost = hostOf(referer);
  if (refererHost !== null) return allowed.has(refererHost);

  // Neither header present: not a browser CSRF vector. Let SameSite handle it.
  return true;
}
