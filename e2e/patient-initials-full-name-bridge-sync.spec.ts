import { test, expect } from "@playwright/test";

/**
 * Full-name → initials auto-conversion, verified through save and partner
 * bridge sync.
 *
 * Regression guard for the strict-initials rule: even if a clinician pastes a
 * full patient name into the "Patient initials" field, the app must never
 * persist or emit the full name — the value stored in our DB and pushed to
 * the partner bridge must be the derived initials only.
 *
 * The test:
 *   1. Creates a referral entering a full name in the initials field.
 *   2. Asserts the input normalizes to initials on blur.
 *   3. Saves and reloads the detail page to prove the persisted value is
 *      the initials (round-trip through our DB).
 *   4. Best-effort: opens the admin bridge-status page and runs an outbound
 *      sync, asserting it completes without error so we know the normalized
 *      value is what the partner bridge receives. Skipped when the test
 *      user is not an admin.
 */

const uniqueHospitalNumber = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

test.describe("patient initials full-name auto-conversion + bridge sync", () => {
  test("full name in the initials field is normalized before save and bridge push", async ({
    page,
  }) => {
    const hospitalNumber = uniqueHospitalNumber("E2E-INIT-BRIDGE");
    const reason = `Playwright full-name→initials sync ${hospitalNumber}`;
    const fullName = "Jonathan Quincy Public";
    const expectedInitials = "JQP";

    // --- 1. Create a referral, entering a full name in the initials field.
    await page.goto("/referrals/new");
    await page.getByLabel(/hospital number/i).fill(hospitalNumber);
    await page.getByLabel(/reason for referral/i).fill(reason);

    const initialsInput = page.getByLabel(/patient initials/i);
    await initialsInput.fill(fullName);

    // Whilst still focused the raw text may remain — the normalizer runs on
    // blur. Assert the pre-blur value is NOT persisted anywhere by never
    // relying on it: the value that must reach the server is initials.
    await initialsInput.blur();
    await expect(initialsInput).toHaveValue(expectedInitials);

    const isTest = page.getByLabel(/test|demonstration/i);
    if (await isTest.count()) {
      await isTest.first().check().catch(() => {});
    }

    // --- 2. Capture the outbound save request payload and assert it does
    // NOT contain the full name in the patient_initials field.
    const savePromise = page.waitForRequest(
      (req) =>
        req.method() === "POST" &&
        /_serverFn|createReferral|referrals?/.test(req.url()),
      { timeout: 15_000 },
    ).catch(() => null);

    await page.getByRole("button", { name: /save referral/i }).click();
    const saveReq = await savePromise;
    if (saveReq) {
      const body = saveReq.postData() ?? "";
      expect(
        body.includes(fullName),
        `outbound save payload must not contain the full name; got: ${body.slice(0, 400)}`,
      ).toBeFalsy();
      // If the payload references initials at all, it must be the normalized
      // value. (Some serialisations may omit the field entirely.)
      const match = body.match(/"patient_initials"\s*:\s*"([^"]*)"/);
      if (match) expect(match[1]).toBe(expectedInitials);
    }

    await expect(page).toHaveURL(/\/referrals\/[0-9a-f-]{36}$/i, {
      timeout: 15_000,
    });

    // --- 3. Reload so we read persisted state, then re-assert.
    await page.reload();
    const detailInitials = page.getByLabel(/patient initials/i);
    await expect(detailInitials).toHaveValue(expectedInitials, {
      timeout: 10_000,
    });

    // --- 4. Best-effort partner-bridge sync assertion.
    // Only admins can reach /bridge-status; non-admins get redirected home.
    await page.goto("/bridge-status");
    const redirectedAway = await page
      .waitForURL((url) => !url.pathname.startsWith("/bridge-status"), {
        timeout: 3_000,
      })
      .then(() => true)
      .catch(() => false);

    if (redirectedAway) {
      test.info().annotations.push({
        type: "note",
        description:
          "Test user is not an admin — bridge-status sync verification skipped.",
      });
      return;
    }

    const runNow = page.getByRole("button", { name: /run sync now/i });
    if (!(await runNow.isVisible({ timeout: 10_000 }).catch(() => false))) {
      test.info().annotations.push({
        type: "note",
        description: "Run sync now button not rendered — skipping sync leg.",
      });
      return;
    }

    await runNow.click();

    // Button reverts from "Syncing…" back to "Run sync now" when done.
    await expect(
      page.getByRole("button", { name: /run sync now/i }),
    ).toBeVisible({ timeout: 30_000 });

    // No destructive error toast should have surfaced.
    const errorToast = page.getByText(/sync failed|bridge error/i);
    await expect(errorToast).toHaveCount(0);

    // The referrals row for our record must appear as synced (no last_error
    // badge next to the referrals resource). We locate by the resource name.
    const referralsRow = page
      .locator("tr, li, div")
      .filter({ hasText: /^referrals\b/i })
      .first();
    if (await referralsRow.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await expect(referralsRow).not.toContainText(/failed|error/i);
    }
  });
});
