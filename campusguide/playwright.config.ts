import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests run against a real production build, not the dev server.
 *
 * Dev and production differ in the ways that matter here — route caching,
 * server-component streaming and the proxy's behaviour on a redirect all change
 * between the two — so testing `next dev` would prove the wrong thing.
 */

const PORT = Number(process.env.E2E_PORT ?? 3200);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  // Every spec here is a whole-app test; none should take anywhere near this.
  timeout: 30_000,
  expect: { timeout: 10_000 },

  // A test that only passes on a retry is a broken test. Locally that should be
  // visible immediately; on CI one retry absorbs genuine runner flakiness
  // (a cold start, a slow first compile) without hiding a real failure.
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  workers: process.env.CI ? 2 : undefined,

  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"]],

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [
    // Runs first and saves a signed-in cookie jar for the others. Both browser
    // projects depend on it, so the whole run costs two sign-ins rather than
    // one per test — see tests/e2e/auth.setup.ts.
    { name: "setup", testMatch: /.*\.setup\.ts/, teardown: "cleanup" },
    { name: "cleanup", testMatch: /.*\.teardown\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },
    // The app is used on phones far more than on laptops, and the navbar has
    // had mobile-only regressions before.
    {
      name: "mobile",
      use: { ...devices["Pixel 7"] },
      dependencies: ["setup"],
    },
  ],

  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `${BASE_URL}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      MONGODB_URI: process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/campusguide",
      NEXTAUTH_SECRET:
        process.env.NEXTAUTH_SECRET ?? "ci-only-secret-not-used-anywhere-else-0123456789",
      NEXTAUTH_URL: BASE_URL,
      ACCOUNT_STATE_TTL_MS: "1000",
    },
  },
});
