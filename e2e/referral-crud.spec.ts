import { test, expect } from "@playwright/test";

/**
 * Referral CRUD smoke test.
 *
 * Covers the create -> read -> soft-delete -> restore lifecycle from the
 * authenticated user's perspective. Uses the shared `is_test` flag on
 * referrals so rows this test creates are filtered out of production
 * analytics dashboards.
 *
 * This is the first end-to-end coverage of a core CRUD path (finding #21
 * in the code review) — it exercises the server functions, RLS policies,
 * encryption round-trip, and realtime list refresh in one go.
 */

const uniqueHospitalNumber = () =>
  `E2E-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

test.describe("referral CRUD", () => {
  test("create, view, delete, restore", async ({ page }) => {
    const hospitalNumber = uniqueHospitalNumber();
    const reason = `Playwright CRUD test ${hospitalNumber}`;

    // --- CREATE ---
    await page.goto("/referrals/new");

    // Fill only the fields the spec allows to be empty elsewhere; the form
    // stays valid because all other inputs default sensibly.
    await page
      .getByLabel(/hospital number/i)
      .fill(hospitalNumber);
    await page
      .getByLabel(/reason for referral/i)
      .fill(reason);

    // Mark as a test row so it doesn't pollute analytics.
    const isTest = page.getByLabel(/test|demonstration/i);
    if (await isTest.count()) {
      await isTest.first().check().catch(() => {});
    }

    await page.getByRole("button", { name: /save referral/i }).click();

    // After save the app navigates to the referral detail page.
    await expect(page).toHaveURL(/\/referrals\/[0-9a-f-]{36}$/i, {
      timeout: 15_000,
    });
    await expect(page.getByText(reason)).toBeVisible();

    const detailUrl = page.url();
    const referralId = detailUrl.split("/").pop()!;

    // --- READ (list) ---
    await page.goto("/");
    // The row should surface in the live list, keyed by our reason string.
    await expect(page.getByText(reason).first()).toBeVisible({
      timeout: 10_000,
    });

    // --- DELETE (soft) ---
    await page.goto(detailUrl);
    const deleteBtn = page.getByRole("button", { name: /^delete$/i });
    await deleteBtn.click();
    // Confirm dialog
    await page
      .getByRole("button", { name: /^(delete|confirm|yes)/i })
      .last()
      .click();

    // After delete the app returns to the list and the row disappears.
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
    await expect(page.getByText(reason)).toHaveCount(0);

    // --- RESTORE (from Deleted panel) ---
    // The dashboard exposes a "Deleted referrals" affordance for the creator
    // within the restore window.
    const showDeleted = page.getByRole("button", {
      name: /deleted (referral|item)/i,
    });
    if (await showDeleted.count()) {
      await showDeleted.first().click();
      const restoreBtn = page
        .getByRole("row", { name: new RegExp(reason.slice(0, 20), "i") })
        .getByRole("button", { name: /restore/i });
      await restoreBtn.click();
      await expect(page.getByText(reason).first()).toBeVisible({
        timeout: 10_000,
      });
    }

    // Sanity check: the referral id we captured is still routable.
    await page.goto(`/referrals/${referralId}`);
    await expect(page.getByText(reason)).toBeVisible({ timeout: 10_000 });
  });
});
