import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Structural contracts across the whole App Router, checked by reading the
 * source rather than importing it (a route module pulls in `next/headers` and
 * a database connection, neither of which exists outside a request).
 *
 * These are the checks nothing else performs. A new admin route that forgets
 * its `requireRole` call is not a type error, not a lint error, and not covered
 * by any unit test — it is simply an admin endpoint open to every signed-in
 * student, and it looks exactly like a correct one until someone finds it.
 */

const APP_DIR = path.join(__dirname, "..", "src", "app");
const API_DIR = path.join(APP_DIR, "api");

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

function walk(dir: string, match: (f: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, match);
    return match(entry.name) ? [full] : [];
  });
}

/** "src/app/api/admin/rooms/[id]/route.ts" -> "/api/admin/rooms/[id]" */
function routePath(file: string) {
  return (
    "/" +
    path
      .relative(APP_DIR, path.dirname(file))
      .split(path.sep)
      .filter((seg) => !(seg.startsWith("(") && seg.endsWith(")")))
      .join("/")
  );
}

const routeFiles = walk(API_DIR, (f) => f === "route.ts");
const pageFiles = walk(APP_DIR, (f) => f === "page.tsx");

const routes = routeFiles.map((file) => ({
  file,
  route: routePath(file),
  source: fs.readFileSync(file, "utf8"),
}));

/**
 * Handlers are declared two ways in this codebase: `export async function GET`
 * on the ordinary routes, and `export { handler as GET, handler as POST }` on
 * the NextAuth catch-all. Both count.
 */
const exportedMethods = (source: string) =>
  HTTP_METHODS.filter(
    (m) =>
      new RegExp(`export\\s+(async\\s+)?(function|const)\\s+${m}\\b`).test(source) ||
      new RegExp(`export\\s*\\{[^}]*\\bas\\s+${m}\\b[^}]*\\}`, "s").test(source),
  );

// Public by design: NextAuth's own handler, plus the four unauthenticated auth
// endpoints. Each is listed individually so adding a new public route is a
// deliberate edit to this file rather than an accident.
const PUBLIC_ROUTES = new Set([
  "/api/auth/[...nextauth]",
  "/api/auth/register",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  "/api/auth/logout",
]);

test("the API surface was actually discovered", () => {
  // Guards against a refactor that moves the routes and turns every assertion
  // below into a vacuous pass over an empty list.
  assert.ok(routes.length >= 40, `expected the full API surface, found ${routes.length} routes`);
  assert.ok(pageFiles.length >= 25, `expected the full page surface, found ${pageFiles.length}`);
});

test("every route file exports at least one HTTP method handler", () => {
  for (const { route, source } of routes) {
    assert.ok(
      exportedMethods(source).length > 0,
      `${route} exports no handler — every request to it 405s`,
    );
  }
});

test("no route file exports a name that looks like a typo'd verb", () => {
  for (const { route, source } of routes) {
    for (const bad of ["Get", "Post", "Patch", "Delete", "PUSH", "UPDATE"]) {
      assert.ok(
        !new RegExp(`export\\s+(async\\s+)?(function|const)\\s+${bad}\\b`).test(source),
        `${route} exports "${bad}", which Next will ignore`,
      );
    }
  }
});

test("every admin API route is behind requireRole('admin')", () => {
  const adminRoutes = routes.filter((r) => r.route.startsWith("/api/admin/"));
  assert.ok(adminRoutes.length > 0, "no admin routes found — the filter is wrong");

  for (const { route, source } of adminRoutes) {
    assert.match(
      source,
      /requireRole\(\s*["']admin["']\s*\)/,
      `${route} is an admin endpoint with no admin guard`,
    );
  }
});

test("every student API route requires a session", () => {
  const studentRoutes = routes.filter((r) => r.route.startsWith("/api/student/"));
  assert.ok(studentRoutes.length > 0, "no student routes found — the filter is wrong");

  for (const { route, source } of studentRoutes) {
    assert.match(
      source,
      /requireSession\(|requireRole\(/,
      `${route} serves student data with no session guard`,
    );
  }
});

test("every non-public route is guarded", () => {
  // The catch-all: any route that is neither explicitly public nor under the
  // two guarded namespaces still has to prove it checks something.
  for (const { route, source } of routes) {
    if (PUBLIC_ROUTES.has(route)) continue;
    assert.match(
      source,
      /requireSession\(|requireRole\(/,
      `${route} is not in PUBLIC_ROUTES and has no guard — add one or list it deliberately`,
    );
  }
});

test("the public route list has no stale entries", () => {
  const known = new Set(routes.map((r) => r.route));
  for (const route of PUBLIC_ROUTES) {
    assert.ok(known.has(route), `${route} is listed as public but no longer exists`);
  }
});

test("state-changing auth routes rate-limit themselves", () => {
  // These are the unauthenticated endpoints an attacker can hit freely:
  // registration, password-reset request, and reset completion.
  for (const route of ["/api/auth/register", "/api/auth/forgot-password", "/api/auth/reset-password"]) {
    const entry = routes.find((r) => r.route === route);
    assert.ok(entry, `${route} is missing`);
    assert.match(
      entry.source,
      /enforceRateLimit|rateLimit/,
      `${route} is unauthenticated and unmetered`,
    );
  }
});

test("no route hard-codes a database URI or secret", () => {
  for (const { route, source } of routes) {
    assert.ok(!/mongodb(\+srv)?:\/\/[^"'`\s]*:[^"'`\s]*@/.test(source), `${route} embeds a Mongo credential`);
    assert.ok(!/NEXTAUTH_SECRET\s*=\s*["']/.test(source), `${route} assigns a literal NEXTAUTH_SECRET`);
  }
});

test("routes read configuration through src/env.ts, not raw process.env", () => {
  // env.ts validates and supplies fallbacks; a direct process.env read bypasses
  // both and fails at runtime instead of at boot.
  const allowed = /process\.env\.(NODE_ENV|NEXT_PHASE|ACCOUNT_STATE_TTL_MS|VERCEL[A-Z_]*|npm_[a-z_]+)/;
  for (const { route, source } of routes) {
    for (const match of source.match(/process\.env\.[A-Z_][A-Z0-9_]*/g) ?? []) {
      assert.match(match, allowed, `${route} reads ${match} directly instead of importing env`);
    }
  }
});

test("every page directory actually contains a page component", () => {
  for (const file of pageFiles) {
    const source = fs.readFileSync(file, "utf8");
    assert.match(
      source,
      /export\s+default\s+(async\s+)?function|export\s+default\s+\w+/,
      `${routePath(file)} has no default export`,
    );
  }
});

test("client components never import server-only modules", () => {
  // A "use client" file that pulls in mongoose or the DB layer either fails the
  // build or ships server code to the browser.
  const clientFiles = [
    ...walk(path.join(__dirname, "..", "src", "components"), (f) => f.endsWith(".tsx")),
    ...pageFiles,
  ];

  for (const file of clientFiles) {
    const source = fs.readFileSync(file, "utf8");
    if (!/^\s*["']use client["']/.test(source)) continue;

    for (const forbidden of ["mongoose", "@/server/db", "@/server/models/", "bcrypt"]) {
      assert.ok(
        !source.includes(`from "${forbidden}`),
        `${path.relative(APP_DIR, file)} is a client component importing ${forbidden}`,
      );
    }
  }
});

test("dynamic route segments are named consistently", () => {
  for (const { route } of routes) {
    for (const segment of route.split("/")) {
      if (!segment.startsWith("[")) continue;
      assert.match(
        segment,
        /^\[(\.\.\.)?[a-z][A-Za-z0-9]*\]$/,
        `${route} has an oddly named dynamic segment "${segment}"`,
      );
    }
  }
});
