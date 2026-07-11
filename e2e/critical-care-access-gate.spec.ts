import { test, expect } from "@playwright/test";

/**
 * Auth gate coverage for the critical care team surfaces.
 *
 * The referral list (`/`) and the bed board (`/bed-board`, which owns the
 * bed edit dialog) live under the integration-managed `_authenticated`
 * layout. Its client-side `beforeLoad` calls `supabase.auth.getUser()` and
 * redirects to `/auth` when no user is present.
 *
 * This spec verifies both from an anonymous browser context:
 *   1. Visiting `/` (referral list) as an unauthenticated user redirects
 *      to `/auth` and the referral list UI never renders.
 *   2. Visiting `/bed-board` as an unauthenticated user redirects to
 *      `/auth` and no bed cell / edit dialog is reachable.
 *   3. As a sanity control, the authenticated clinician (the default
 *      storage state) CAN reach the referral list and CAN open the bed
 *      edit dialog when an occupied bed is visible (skipped cleanly when
 *      the partner bridge is offline in this env).
 */

test.describe("critical care team access gate — unauthenticated", () => {
  // Wipe the shared storage state so this project runs as a fresh browser
  // with no Supabase session in localStorage or cookies.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("anonymous visitor to /referrals list is redirected to /auth", async ({
    page,
  }) => {
    await page.goto("/");
    // _authenticated/route.tsx throws redirect({ to: "/auth" }) when
    // supabase.auth.getUser() returns no user.
    await expect(page).toHaveURL(/\/auth(\?|$)/, { timeout: 15_000 });

    // The auth page must be showing, not a flash of the referral list.
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible({
      timeout: 10_000,
    });
    // Referral-list surfaces must not be present.
    await expect(
      page.getByRole("heading", { name: /referrals?/i }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: /new referral/i }),
    ).toHaveCount(0);
  });

  test("anonymous visitor to /bed-board is redirected to /auth (no dialog reachable)", async ({
    page,
  }) => {
    await page.goto("/bed-board");
    await expect(page).toHaveURL(/\/auth(\?|$)/, { timeout: 15_000 });

    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible({
      timeout: 10_000,
    });

    // No bed cell should be interactable, and no edit dialog can exist.
    await expect(
      page.locator('[role="button"][aria-label^="Bed "]'),
    ).toHaveCount(0);
    await expect(
      page.getByRole("dialog", { name: /edit patient/i }),
    ).toHaveCount(0);
  });
});

test.describe("critical care team access gate — authenticated clinician", () => {
  test("clinician CAN reach the referral list", async ({ page }) => {
    await page.goto("/");
    // Must NOT be bounced to /auth.
    await expect(page).not.toHaveURL(/\/auth(\?|$)/);
    // A "new referral" affordance is the deterministic list-surface signal.
    await expect(
      page.getByRole("link", { name: /new referral/i }).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("clinician CAN open the bed edit dialog", async ({ page }) => {
    await page.goto("/bed-board");
    await expect(page).not.toHaveURL(/\/auth(\?|$)/);

    const anyOccupied = page
      .locator('[role="button"][aria-label^="Bed "]')
      .filter({ hasNot: page.locator("text=Empty") })
      .first();
    if (
      !(await anyOccupied.isVisible({ timeout: 15_000 }).catch(() => false))
    ) {
      test.skip(
        true,
        "No occupied beds visible — partner bridge likely offline in this env.",
      );
    }

    await anyOccupied.click();
    await expect(
      page.getByRole("dialog", { name: /edit patient/i }),
    ).toBeVisible({ timeout: 10_000 });
  });
});
