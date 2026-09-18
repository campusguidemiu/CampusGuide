import { RateLimiterMemory } from "rate-limiter-flexible";
import { getRequestIp } from "@/server/security/requestIp";

export { getRequestIp };

type RateLimitOptions = {
  points?: number;
  duration?: number;
  identity?: string;
};

const defaultPoints = 20;
const defaultDuration = 60;

const limiters = new Map<string, RateLimiterMemory>();

function getLimiter(points: number, duration: number) {
  const key = `${points}:${duration}`;
  const existing = limiters.get(key);
  if (existing) return existing;

  const created = new RateLimiterMemory({ points, duration });
  limiters.set(key, created);
  return created;
}

export async function enforceRateLimit(headers: Headers, key: string, opts?: RateLimitOptions) {
  const points = opts?.points ?? defaultPoints;
  const duration = opts?.duration ?? defaultDuration;

  const identity = opts?.identity ?? getRequestIp(headers);
  const compositeKey = `${key}:${identity}`;

  // Every route calls this before doing anything else, which makes it the one
  // place a block can be enforced across the whole API — including the auth
  // routes, where blocking matters most. Imported lazily for the same reason as
  // the alerts below: a static import would pull mongoose into the proxy bundle.
  //
  // Checked before consuming a point so a blocked caller cannot burn through
  // the budget that a legitimate user behind the same limit key needs.
  const ip = getRequestIp(headers);
  const { isIpBlocked, blockedResponse } = await import("@/server/security/ipBlock");
  if (await isIpBlocked(ip)) return blockedResponse();

  const limiter = getLimiter(points, duration);
  try {
    await limiter.consume(compositeKey);
    return null;
  } catch {
    // Imported lazily: this module is pulled into the middleware/proxy bundle,
    // and a static import would drag mongoose in with it.
    void import("@/server/security/alerts")
      .then((m) => m.recordRateLimitBreach({ routeKey: key, identity, ip: getRequestIp(headers) }))
      .catch(() => {
        // Detection is best-effort; a 429 still goes back either way.
      });

    return new Response(JSON.stringify({ error: "Too many requests" }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  }
}
