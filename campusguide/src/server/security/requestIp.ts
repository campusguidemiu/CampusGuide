import { UNKNOWN_IP } from "@/lib/ipBlocks";

/**
 * The caller's address, from a header the caller cannot forge.
 *
 * This is a security boundary, not a convenience: the value returned here keys
 * the rate limiter and is matched against the IP block list, so whoever
 * controls it controls both. `x-forwarded-for` is a request header like any
 * other — a client can send one, and a proxy that appends rather than replaces
 * leaves the caller's own text sitting in front of the real address. Reading
 * `xff.split(",")[0]` therefore hands an attacker a fresh rate-limit bucket per
 * request and a way past every IP block, just by varying a header.
 *
 * Preference order, most trustworthy first:
 *   1. `x-vercel-forwarded-for` - written by Vercel's edge from the real
 *      connection, and stripped from anything the client sends.
 *   2. `x-real-ip` - single value, set by the platform or reverse proxy.
 *   3. `x-forwarded-for`, but the LAST hop rather than the first. The entry
 *      nearest the server is the one our own proxy observed; the first is
 *      whatever the caller typed. Only reached in local dev or self-hosting.
 */

type HeaderLookup = (name: string) => string | null;

function firstValue(raw: string): string | null {
  const value = raw.split(",")[0]?.trim();
  return value ? value : null;
}

function lastValue(raw: string): string | null {
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

function resolve(get: HeaderLookup): string {
  const vercel = get("x-vercel-forwarded-for");
  if (vercel) {
    const value = firstValue(vercel);
    if (value) return value;
  }

  const real = get("x-real-ip");
  if (real) {
    const value = real.trim();
    if (value) return value;
  }

  const forwarded = get("x-forwarded-for");
  if (forwarded) {
    const value = lastValue(forwarded);
    if (value) return value;
  }

  return UNKNOWN_IP;
}

/** For route handlers and middleware, which get a real `Headers`. */
export function getRequestIp(headers: Headers): string {
  return resolve((name) => headers.get(name));
}

/**
 * For NextAuth's `authorize`, which is handed a plain header bag rather than a
 * `Headers`. Same precedence, so the sign-in path and every other route agree
 * on who the caller is - they have to, or a block enforced on one is invisible
 * to the other.
 */
export function getRequestIpFromBag(
  bag: Record<string, string | string[] | undefined> | undefined
): string {
  if (!bag) return UNKNOWN_IP;

  return resolve((name) => {
    const value = bag[name] ?? bag[name.toLowerCase()];
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  });
}
