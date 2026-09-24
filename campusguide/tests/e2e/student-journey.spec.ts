import { test, expect } from "@playwright/test";
import {
  ADMIN_STATE,
  STUDENT_STATE,
  closeDb,
  createAccount,
  deleteAccount,
  signIn,
} from "./helpers";

/**
 * A signed-in student, driven through the browser.
 *
 * The API suite proves the endpoints answer correctly; this proves the pages
 * built on them actually render. Those are different failures — a server
 * component that throws on a null field returns a perfectly good JSON payload
 * from its route and a blank screen to the student.
 *
 * The session comes from auth.setup.ts rather than a login per test, because
 * sign-in is rate limited; see the note there.
 */

test.use({ storageState: STUDENT_STATE });

test("the saved session reaches the dashboard", async ({ page }) => {
  const response = await page.goto("/dashboard");

  expect(response?.status()).toBeLessThan(400);
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.locator("body")).not.toContainText(/Application error/i);
});

const STUDENT_PAGES = [
  "/dashboard",
  "/calendar",
  "/attendance",
  "/gpa/calculator",
  "/gpa/estimator",
  "/map",
  "/resources",
  "/teams",
  "/videos",
  "/faq",
  "/profile",
];

for (const path of STUDENT_PAGES) {
  test(`${path} renders for a signed-in student`, async ({ page }) => {
    const response = await page.goto(path);
    expect(response?.status(), `${path} returned an error status`).toBeLessThan(400);

    // Landing back on /login would mean the guard rejected a valid session.
    await expect(page).toHaveURL(new RegExp(path.replace(/\//g, "\\/")));
    await expect(page.locator("body")).not.toContainText(
      /Application error|Internal Server Error/i,
    );
    // A page that renders its shell but no content still counts as broken.
    await expect(page.locator("main").first()).not.toBeEmpty();
  });
}

test("the student navigation offers no admin link", async ({ page }) => {
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });

  // The nav exists on both viewports but is collapsed behind a menu button on
  // mobile, so presence — not visibility — is the property that holds for both.
  await expect(page.locator("nav")).not.toHaveCount(0);

  // The part that actually matters: a student who can see an admin link will
  // click it and get bounced at best; at worst the role check moved to the
  // client. Checked across the whole document so a collapsed mobile menu
  // cannot hide a link that is still in the markup.
  await expect(page.locator('a[href^="/admin"]')).toHaveCount(0);
});

test("a student is redirected away from the admin area", async ({ page }) => {
  await page.goto("/admin/users");

  // The proxy sends them somewhere real rather than leaving a blank 307.
  await expect(page).not.toHaveURL(/\/admin\/users/);
  await expect(page.locator("body")).not.toContainText(/verification queue/i);
});

test("a student calling an admin API is forbidden, not unauthorized", async ({ page }) => {
  const response = await page.request.get("/api/admin/users", { maxRedirects: 0 });

  // 403 not 401: the distinction says the session was valid but the role was
  // not, which is what the client uses to decide whether to re-prompt.
  expect(response.status()).toBe(403);
});

test("a student cannot modify another student's data through the API", async ({ page, baseURL }) => {
  // The by-id routes expose PATCH and DELETE rather than GET, so ownership is
  // what this has to probe. The id is well-formed but belongs to nobody: a 200
  // would mean the route never checked the owner, and a 500 would mean it
  // crashed on the lookup instead of answering.
  const response = await page.request.patch("/api/student/events/64b7f9c2a1e4d3b2c1a09876", {
    headers: { origin: baseURL!, "content-type": "application/json" },
    data: { title: "not mine" },
    maxRedirects: 0,
  });

  expect([403, 404]).toContain(response.status());
});

test("signing out revokes the session everywhere, not just this tab", async ({ browser, baseURL }) => {
  // Seeds an account, signs in through the real form and then replays a cookie,
  // so it needs more than the 30s default a page-render test is tuned for.
  test.setTimeout(90_000);

  // Its own context: this test destroys the session it signs in with, and the
  // shared storageState is needed by everything else.
  const victim = await createAccount({ status: "active" });
  // `storageState: undefined` is load-bearing. Playwright applies the file's
  // `test.use({ storageState })` to browser.newContext() as well, so without
  // this the "fresh" context arrives already signed in as the shared student —
  // /login then redirects straight to /dashboard and the sign-in form this test
  // needs is never rendered.
  const context = await browser.newContext({ storageState: undefined });
  const page = await context.newPage();

  try {
    await signIn(page, victim);
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });

    const cookies = await context.cookies();

    // isSessionRevoked() applies a deliberate one-second floor
    // (`minted < cutoff - 1000`) so that logging in never revokes the token the
    // login just minted. Logging out inside that window is therefore *supposed*
    // to leave the cookie working; wait it out so this asserts revocation
    // rather than the floor.
    await page.waitForTimeout(1200);

    const response = await page.request.post("/api/auth/logout", {
      headers: { origin: baseURL!, "content-type": "application/json" },
    });
    expect(response.status()).toBeLessThan(400);

    // Replay the captured cookie against a guarded API. Logout stamps
    // `sessionsValidFrom`, so the still-unexpired JWT must now be refused —
    // this is the pentest Finding 1 behaviour. A cookie-only signOut would
    // pass a UI check and fail this one.
    const replay = await context.request.get("/api/student/profile", {
      headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") },
    });
    expect(replay.status()).toBe(401);
  } finally {
    await context.close();
    await deleteAccount(victim.email);
    await closeDb();
  }
});

test("a banned account loses access on its very next request", async ({ browser, baseURL }) => {
  // Two contexts, a sign-in and a cache window to wait out.
  test.setTimeout(90_000);

  const victim = await createAccount({ status: "active" });
  // Signed out for the same reason as above — see the note in the logout test.
  const victimContext = await browser.newContext({ storageState: undefined });
  const victimPage = await victimContext.newPage();

  // The admin acts through the saved admin session, so this costs one sign-in.
  const adminContext = await browser.newContext({ storageState: ADMIN_STATE });

  try {
    await signIn(victimPage, victim);
    expect((await victimPage.request.get("/api/student/profile")).status()).toBe(200);

    // Same one-second floor as the logout test above.
    await victimPage.waitForTimeout(1200);

    const search = await adminContext.request.get(
      `/api/admin/users?q=${encodeURIComponent(victim.miuId)}`,
    );
    const results = await search.json();
    const found = results?.items?.[0];
    expect(found, `admin search returned: ${JSON.stringify(results).slice(0, 300)}`).toBeTruthy();
    expect(found.email, "the search should return the victim, not another account").toBe(victim.email);

    const banned = await adminContext.request.patch(`/api/admin/users/${found.id}`, {
      headers: { origin: baseURL!, "content-type": "application/json" },
      data: { action: "ban", reason: "e2e" },
    });
    expect(banned.status(), `ban failed: ${(await banned.text()).slice(0, 300)}`).toBe(200);

    // No sleep: the ban invalidates this account's cached state as part of the
    // write, so the very next request must already be refused. Waiting here
    // would let a *stale cache* pass the test on the TTL expiring instead.
    expect((await victimPage.request.get("/api/student/profile")).status()).toBe(401);
  } finally {
    await victimContext.close();
    await adminContext.close();
    await deleteAccount(victim.email);
    await closeDb();
  }
});
