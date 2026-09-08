import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { env } from "@/env";
import { isRequestCsrfSafe, isUnsafeMethod } from "@/lib/csrf";

function isApi(pathname: string) {
  return pathname.startsWith("/api/");
}

/** The host of NEXTAUTH_URL, if it is set, so it counts as our own origin. */
function configuredHost(): string | null {
  try {
    return env.NEXTAUTH_URL ? new URL(env.NEXTAUTH_URL).host : null;
  } catch {
    return null;
  }
}

/**
 * Forwards the path to server components. The layout needs it to know whether
 * the current page is the one screen an unverified account may see.
 */
function passThrough(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.set("x-pathname", req.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

/**
 * Everything behind a sign-in.
 *
 * This list and `config.matcher` at the bottom must agree. The matcher decides
 * which requests reach this function at all; this decides which of them get
 * guarded. Adding a page to only one of them is silent: /profile was in the
 * matcher but missing here, so the proxy ran and waved it straight through to
 * an unauthenticated visitor.
 *
 * `tests/proxy.test.ts` compares the two and fails if they ever diverge again.
 */
export const PROTECTED_PREFIXES = [
  "/dashboard",
  "/gpa",
  "/attendance",
  "/calendar",
  "/resources",
  "/videos",
  "/faq",
  "/map",
  "/teams",
  "/profile",
  "/pending",
  "/admin",
  "/api/student",
  "/api/admin",
] as const;

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const needsAuth = PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix));

  if (!needsAuth) return passThrough(req);

  // CSRF backstop for every state-changing request on the guarded surface. Runs
  // before the auth check so a cross-site forgery is refused outright, whatever
  // cookie it carried. See `lib/csrf.ts` — a browser cannot strip the Origin it
  // attaches to a cross-site POST/PATCH/PUT/DELETE, so a forged request from
  // another site fails to match our host and is rejected here.
  if (isApi(pathname) && isUnsafeMethod(req.method)) {
    const safe = isRequestCsrfSafe({
      method: req.method,
      origin: req.headers.get("origin"),
      referer: req.headers.get("referer"),
      allowedHosts: [
        req.headers.get("host"),
        req.headers.get("x-forwarded-host"),
        configuredHost(),
      ],
    });
    if (!safe) {
      return new NextResponse(JSON.stringify({ error: "CSRF check failed" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
  }

  const token = await getToken({ req, secret: env.NEXTAUTH_SECRET });

  // An expired short session is stripped of its identity claims by the `jwt`
  // callback rather than deleted, so the object survives and `!token` alone
  // would wave it through. No `sub` means no user.
  const signedIn = Boolean(token?.sub);

  if (!signedIn) {
    if (isApi(pathname)) {
      return new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Account status is deliberately not checked here. Middleware can only read
  // the JWT, which stays valid for weeks after a ban; the (app) layout and the
  // API guards re-read the database instead, so revocation is immediate.

  if (pathname.startsWith("/api/admin") || pathname.startsWith("/admin")) {
    if ((token as any).role !== "admin") {
      if (isApi(pathname)) {
        return new NextResponse(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      // A 307 without a Location header leaves the browser on a blank page.
      // Send non-admins back to a page they can actually use.
      const url = req.nextUrl.clone();
      url.pathname = "/dashboard";
      url.search = "";
      return NextResponse.redirect(url);
    }
  }

  if (pathname.startsWith("/api/student")) {
    // Admins should be able to use student APIs as well (admin is a superuser).
    if ((token as any).role !== "student" && (token as any).role !== "admin") {
      return new NextResponse(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
  }

  return passThrough(req);
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/gpa/:path*",
    "/attendance/:path*",
    "/calendar/:path*",
    "/resources/:path*",
    "/videos/:path*",
    "/faq/:path*",
    "/map/:path*",
    "/teams/:path*",
    "/profile/:path*",
    "/pending/:path*",
    "/admin/:path*",
    "/api/student/:path*",
    "/api/admin/:path*",
  ],
};
