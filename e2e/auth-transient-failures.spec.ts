import { test, expect, type Route } from "@playwright/test";

/**
 * Simulates transient Supabase auth network failures and verifies the
 * retry logic in src/lib/retry.ts keeps the user on the authenticated
 * route instead of bouncing them back to /auth.
 *
 * Strategy: intercept calls to `**\/auth/v1/**` and fail the first N
 * attempts with an aborted/5xx response, then let subsequent attempts
 * pass through. The retry helper uses exponential backoff (base 250ms,
 * max 4s) with up to 3 retries — so 2 transient failures should still
 * resolve successfully well under the test timeout.
 */

const AUTH_GLOB = "**/auth/v1/**";

/**
 * Returns a Playwright route handler that fails the first `failures`
 * matching requests, then continues all subsequent ones.
 */
function flakyAuth(failures: number, mode: "abort" | "500" = "abort") {
  let count = 0;
  return async (route: Route) => {
    // Only flake on the token / user / session endpoints, not assets.
    const url = route.request().url();
    if (!/\/auth\/v1\/(token|user|session|recover|signup|logout)/.test(url)) {
      return route.continue();
    }
    count += 1;
    if (count <= failures) {
      if (mode === "abort") return route.abort("connectionfailed");
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "transient upstream error" }),
      });
    }
    return route.continue();
  };
}

test.describe("transient supabase auth failures", () => {
  test("sign-in retries past 2 transient failures and lands on authenticated route", async ({
    browser,
  }) => {
    const email = process.env.E2E_EMAIL;
    const password = process.env.E2E_PASSWORD;
    test.skip(!email || !password, "E2E_EMAIL / E2E_PASSWORD not set");

    // Fresh, unauthenticated context so we go through the real sign-in flow.
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    await page.route(AUTH_GLOB, flakyAuth(2, "abort"));

    await page.goto("/auth");
    await page.getByLabel(/email/i).fill(email!);
    await page.getByLabel(/password/i).fill(password!);
    await page.getByRole("button", { name: /sign in/i }).click();

    // Retry toast should appear after the first failure.
    await expect(page.getByText(/retrying sign in/i)).toBeVisible({
      timeout: 10_000,
    });

    // The retry must eventually succeed and route to "/" — NOT bounce
    // the user back to /auth.
    await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
    await expect(page).not.toHaveURL(/\/auth/);

    await context.close();
  });

  test("non-transient credential errors are NOT retried away", async ({
    browser,
  }) => {
    const email = process.env.E2E_EMAIL;
    test.skip(!email, "E2E_EMAIL not set");

    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();

    await page.goto("/auth");
    await page.getByLabel(/email/i).fill(email!);
    await page.getByLabel(/password/i).fill("definitely-not-the-real-password");
    await page.getByRole("button", { name: /sign in/i }).click();

    // Real auth error surfaces to the user — should stay on /auth.
    await expect(page.getByText(/invalid|credentials/i).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page).toHaveURL(/\/auth/);

    await context.close();
  });

  test("transient auth failure on an authenticated page does NOT redirect to /auth", async ({
    browser,
  }) => {
    // Reuse the stored session from global.setup.ts.
    const context = await browser.newContext({
      storageState: "e2e/.auth/user.json",
    });
    const page = await context.newPage();

    // Fail the first 2 auth/v1/* hits (e.g. background token refresh,
    // getUser revalidation) — the route gate uses getSession() against
    // localStorage so the navigation itself must NOT depend on these.
    await page.route(AUTH_GLOB, flakyAuth(2, "500"));

    await page.goto("/referrals/new");

    // We must stay on the authenticated route — the gate / retry logic
    // should not bounce us to /auth when /auth/v1/user transiently 5xx's.
    await expect(page).toHaveURL(/\/referrals\/new/, { timeout: 15_000 });
    await expect(page).not.toHaveURL(/\/auth(\?|$)/);

    // The form should render (proves the route mounted, not a redirect spinner).
    await expect(
      page.getByRole("button", { name: /save referral/i }),
    ).toBeVisible({ timeout: 15_000 });

    await context.close();
  });

  test("retry toast appears on first retry and disappears after successful authenticated navigation", async ({
    browser,
  }) => {
    const email = process.env.E2E_EMAIL;
    const password = process.env.E2E_PASSWORD;
    test.skip(!email || !password, "E2E_EMAIL / E2E_PASSWORD not set");

    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();

    // One transient failure → exactly one retry → toast should appear once.
    await page.route(AUTH_GLOB, flakyAuth(1, "abort"));

    await page.goto("/auth");
    await page.getByLabel(/email/i).fill(email!);
    await page.getByLabel(/password/i).fill(password!);
    await page.getByRole("button", { name: /sign in/i }).click();

    // 1) Toast text appears on the first retry.
    const toast = page.getByText(/retrying sign in/i);
    await expect(toast).toBeVisible({ timeout: 10_000 });

    // 2) Sign-in succeeds and we navigate to the authenticated route.
    await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
    await expect(page).not.toHaveURL(/\/auth/);

    // 3) After successful navigation the toast is dismissed (sonner
    //    auto-dismiss ~4s; allow generous margin).
    await expect(toast).toHaveCount(0, { timeout: 15_000 });

    await context.close();
  });

  test("no retry toast appears when the first auth request succeeds", async ({
    browser,
  }) => {
    const email = process.env.E2E_EMAIL;
    const password = process.env.E2E_PASSWORD;
    test.skip(!email || !password, "E2E_EMAIL / E2E_PASSWORD not set");

    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();

    // No flakyAuth handler: every auth/v1 request succeeds on the first try.

    await page.goto("/auth");
    await page.getByLabel(/email/i).fill(email!);
    await page.getByLabel(/password/i).fill(password!);
    await page.getByRole("button", { name: /sign in/i }).click();

    // User should land on the authenticated route without ever showing a retry toast.
    await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
    await expect(page).not.toHaveURL(/\/auth/);

    const retryToast = page.getByText(/retrying sign in/i);
    await expect(retryToast).toHaveCount(0);

    await context.close();
  });
});
