import { test, expect } from "@playwright/test";
import { PROTECTED_PREFIXES } from "../../src/proxy";

/**
 * The front door, exercised through a real browser.
 *
 * `tests/proxy.test.ts` already checks that the prefix list and the matcher
 * agree, but that is a comparison of two arrays — it cannot tell you whether
 * the deployed middleware actually runs. This drives every guarded path with no
 * cookies and asserts the visitor is turned away, which is the property that
 * actually matters.
 *
 * The list is imported from the proxy rather than copied, so a page added to
 * the app is covered here the moment it is protected.
 */

const PAGE_PREFIXES = PROTECTED_PREFIXES.filter((p) => !p.startsWith("/api"));
const API_PREFIXES = PROTECTED_PREFIXES.filter((p) => p.startsWith("/api"));

test("the guarded surface was discovered", () => {
  // Stops this whole file quietly passing over an empty list.
  expect(PAGE_PREFIXES.length).toBeGreaterThan(8);
  expect(API_PREFIXES.length).toBeGreaterThan(0);
});

for (const prefix of PAGE_PREFIXES) {
  test(`${prefix} redirects a signed-out visitor to the login page`, async ({ page }) => {
    await page.goto(prefix);

    await expect(page).toHaveURL(/\/login/);
    // The redirect carries where they were going so they land there after
    // signing in; losing it drops everyone on the dashboard instead.
    expect(new URL(page.url()).searchParams.get("next")).toBe(prefix);
  });
}

for (const prefix of API_PREFIXES) {
  test(`${prefix} answers 401 rather than redirecting`, async ({ request }) => {
    const response = await request.get(prefix, { maxRedirects: 0 });

    // An API that 302s to an HTML login page breaks every fetch() caller, which
    // then parses a redirect as JSON and reports a confusing error.
    expect(response.status()).toBe(401);
    expect(response.headers()["content-type"]).toContain("application/json");
  });
}

test("the admin area is not reachable without a session", async ({ page }) => {
  await page.goto("/admin/users");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.locator("body")).not.toContainText(/verification queue|banned/i);
});

test("a cross-site state-changing request is refused", async ({ request }) => {
  // The CSRF backstop in the proxy. Runs ahead of the auth check, so this must
  // be a 403 and specifically not a 401.
  const response = await request.post("/api/student/events", {
    headers: { origin: "https://evil.example.com", "content-type": "application/json" },
    data: { title: "forged" },
    maxRedirects: 0,
  });

  expect(response.status()).toBe(403);
  expect(await response.json()).toMatchObject({ error: /CSRF/i });
});

test("a same-site request gets past CSRF and is stopped by auth instead", async ({
  request,
  baseURL,
}) => {
  const response = await request.post("/api/student/events", {
    headers: { origin: baseURL!, "content-type": "application/json" },
    data: { title: "x" },
    maxRedirects: 0,
  });

  // Proves the two checks are ordered and independent: this one clears CSRF and
  // is refused for the right reason.
  expect(response.status()).toBe(401);
});

test("a public path is not caught by the guard", async ({ page }) => {
  // A matcher that is too broad would redirect the login page to itself.
  await page.goto("/login");
  await expect(page).toHaveURL(/\/login$/);
});
