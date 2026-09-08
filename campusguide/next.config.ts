import type { NextConfig } from "next";

// Application-wide security headers (pentest Finding 4). HSTS is already set by
// Vercel's edge and is intentionally not duplicated here.
//
// The CSP is the involved one. Next.js injects inline bootstrap/hydration
// scripts and styled-jsx styles with no nonce, so 'unsafe-inline' is required
// for the app to run; dev additionally needs 'unsafe-eval' for HMR. The policy
// still buys real protection: framing is denied, plugins/base-uri/form targets
// are locked to the origin, and the only third-party frame allowed is YouTube's
// no-cookie embed domain the video player uses.
const isDev = process.env.NODE_ENV !== "production";

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  // va.vercel-scripts.com serves the Vercel Web Analytics script (<Analytics />).
  `script-src 'self' 'unsafe-inline' https://va.vercel-scripts.com${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  // Thumbnails come from i.ytimg.com and the R2 bucket; https: keeps future
  // image hosts working without weakening this to allow http/mixed content.
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  // Same-origin APIs, plus cross-origin https for the R2 download redirects.
  "connect-src 'self' https:",
  "frame-src https://www.youtube-nocookie.com",
  "media-src 'self' https:",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
];

const nextConfig: NextConfig = {
  // Reduce bandwidth: enable compression, modern image formats, and cache versioned public assets.
  compress: true,
  poweredByHeader: false,
  experimental: {
    // Client-side router cache, meant to stop every back-and-forth between two
    // pages from refetching the RSC payload.
    //
    // MEASURED: this has no effect on this app, in dev or in production.
    // Navigating away and back re-fetches the RSC payload every time.
    //
    // The first guess was that the missing loading.tsx boundaries were the
    // blocker. They were added later, and re-measuring showed the same two
    // refetches on a revisit — so that was not the cause. The remaining
    // explanation is that every route is fully dynamic: the (app) layout calls
    // headers() and getServerSession() on each request, and the router will not
    // reuse a cached entry for a route it has to re-render anyway.
    //
    // Left in place because it costs nothing and is the correct setting, but do
    // not count it as a bandwidth saving unless someone re-measures and shows
    // otherwise.
    staleTimes: {
      dynamic: 30,
      static: 180,
    },
  },
  images: {
    formats: ["image/avif", "image/webp"],
    // These are static files in /public that only change when renamed, so a
    // 60-second TTL just pays for the same optimization over and over.
    minimumCacheTTL: 31536000,
  },
  async headers() {
    return [
      {
        // Every route gets the security headers.
        source: "/:path*",
        headers: securityHeaders,
      },
      {
        // Cache-bustable assets (rename when you change the file)
        source: "/campus-map-v3.png",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        source: "/retromo1nobg.png",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

export default nextConfig;
