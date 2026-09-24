import { test, expect } from "@playwright/test";

/**
 * The pages a signed-out visitor can reach.
 *
 * These are the only surfaces a stranger — or a search engine — ever sees, and
 * they are the ones nothing else tests: the API suites drive JSON endpoints and
 * the unit suites never render anything. A server-component crash on /login
 * takes the whole app offline for everyone and would otherwise reach production
 * unnoticed.
 */

const PUBLIC_PAGES = [
  { path: "/login", expect: /sign in|log in|login/i },
  { path: "/register", expect: /register|create|sign up/i },
  { path: "/forgot-password", expect: /password/i },
  { path: "/reset-password", expect: /password/i },
  { path: "/terms", expect: /terms|responsibility/i },
  { path: "/privacy", expect: /privacy|data/i },
];

for (const page of PUBLIC_PAGES) {
  test(`${page.path} renders without an error`, async ({ page: browser }) => {
    const response = await browser.goto(page.path);

    expect(response?.status(), `${page.path} should not be an error page`).toBeLessThan(400);
    // Next renders its error boundary with a 200 in some cases, so the status
    // alone is not enough — check the page is not the crash screen.
    await expect(browser.locator("body")).not.toContainText(
      /Application error|Internal Server Error|500/i,
    );
    await expect(browser.locator("body")).toContainText(page.expect);
  });
}

test("the login form has the fields a student needs", async ({ page }) => {
  await page.goto("/login");

  // Students sign in with either an email or a student ID, so the field must
  // not be type=email — the browser's own validation would refuse to submit
  // "2024/15832" and lock out everyone who uses their ID.
  const identifier = page.locator('input[autocomplete="username"]').first();
  await expect(identifier).toBeVisible();
  await expect(identifier).toHaveAttribute("type", "text");
  await expect(page.locator('input[type="password"]').first()).toBeVisible();
  await expect(page.locator('button[type="submit"], input[type="submit"]').first()).toBeVisible();
});

test("the register form requires accepting the terms", async ({ page }) => {
  await page.goto("/register");

  // The consent checkbox is the stored proof under acceptedTermsVersion. If it
  // disappears, accounts are created with no recorded consent at all.
  await expect(page.locator('input[type="checkbox"]').first()).toBeVisible();
});

test("the terms page shows every section the consent refers to", async ({ page }) => {
  await page.goto("/terms");

  const body = page.locator("body");
  await expect(body).toContainText(/attendance calculator/i);
  await expect(body).toContainText(/MIU/);
  await expect(body).toContainText(/own (risk|responsibility)/i);
});

test("every page sets a title and a language", async ({ page }) => {
  for (const { path } of PUBLIC_PAGES) {
    await page.goto(path);

    await expect(page).toHaveTitle(/.+/);
    // Without lang, a screen reader guesses the language of the whole document.
    await expect(page.locator("html")).toHaveAttribute("lang", /.+/);
  }
});

test("no public page logs a console error", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    // A "Failed to load resource" message carries no URL in its text — the
    // originating URL is only on the location, so record both.
    errors.push(`${msg.text()} @ ${msg.location().url}`);
  });
  page.on("pageerror", (err) => errors.push(err.message));

  for (const { path } of PUBLIC_PAGES) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
  }

  /**
   * Two classes of error are artifacts of running a production build on a plain
   * http origin, and neither says anything about the app:
   *
   * 1. `@vercel/analytics` requests /_vercel/insights/script.js, which Vercel's
   *    edge injects and which exists nowhere else, so it 404s on every local
   *    and CI run.
   * 2. The CSP sets `upgrade-insecure-requests` (correct in production, where
   *    the app is https-only). Over http://localhost the browser dutifully
   *    upgrades every prefetch to https and the connection fails with
   *    ERR_SSL_PROTOCOL_ERROR.
   *
   * Both are matched on their originating URL rather than by ignoring 404s or
   * network errors wholesale, so a genuinely missing asset still fails here.
   */
  const environmentNoise = [
    /_vercel\/(insights|speed-insights)/i,
    /favicon/i,
    /net::ERR_SSL_PROTOCOL_ERROR @ https:\/\/localhost:/i,
    /net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED)/i,
  ];

  const real = errors.filter((e) => !environmentNoise.some((pattern) => pattern.test(e)));
  expect(real, `console errors: ${real.join(" | ")}`).toHaveLength(0);
});

test("an unknown page returns a real 404", async ({ page }) => {
  const response = await page.goto("/this-page-does-not-exist");
  expect(response?.status()).toBe(404);
});
