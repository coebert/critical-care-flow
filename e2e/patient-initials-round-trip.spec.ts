import { test, expect } from "@playwright/test";

/**
 * Patient initials round-trip.
 *
 * Verifies that the strict-initials validation added to referrals, post-op
 * HDU bookings, and the bed-board / partner-bridge edit dialog:
 *
 *   1. Accepts a full name in the input field, and
 *   2. Persists ONLY the derived initials (e.g. "John Smith" → "JS"), and
 *   3. Round-trips the persisted initials on subsequent reads —
 *      including via the partner bridge for the bed-board case.
 *
 * The referral and post-op checks are deterministic and always run.
 * The bed-board / partner-bridge check requires an occupied bed on the
 * partner unit; if the bridge is offline or no beds are occupied in this
 * environment we skip that leg rather than fail on infra we don't own.
 */

const uniqueHospitalNumber = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

test.describe("patient initials round-trip", () => {
  test("referral form auto-converts a full name to initials on save", async ({
    page,
  }) => {
    const hospitalNumber = uniqueHospitalNumber("E2E-REF");
    const reason = `Playwright initials referral ${hospitalNumber}`;

    await page.goto("/referrals/new");

    await page.getByLabel(/hospital number/i).fill(hospitalNumber);
    await page.getByLabel(/reason for referral/i).fill(reason);

    // Type a full name, then blur — the input should normalize live.
    const initialsInput = page.getByLabel(/patient initials/i);
    await initialsInput.fill("John Smith");
    await initialsInput.blur();
    await expect(initialsInput).toHaveValue("JS");

    const isTest = page.getByLabel(/test|demonstration/i);
    if (await isTest.count()) {
      await isTest.first().check().catch(() => {});
    }

    await page.getByRole("button", { name: /save referral/i }).click();
    await expect(page).toHaveURL(/\/referrals\/[0-9a-f-]{36}$/i, {
      timeout: 15_000,
    });

    // Reload the detail page so we prove the value came back from the server.
    await page.reload();
    const detailInitials = page.getByLabel(/patient initials/i);
    await expect(detailInitials).toHaveValue("JS", { timeout: 10_000 });

    // Belt & braces: even if the user pastes a full name straight into the
    // detail page, blur must normalize it again.
    await detailInitials.fill("Alice Bernard Carter");
    await detailInitials.blur();
    await expect(detailInitials).toHaveValue("ABC");
  });

  test("post-op HDU booking auto-converts a full name to initials on save", async ({
    page,
  }) => {
    const hospitalNumber = uniqueHospitalNumber("E2E-POSTOP");
    const procedure = `Playwright initials booking ${hospitalNumber}`;

    await page.goto("/postop-bookings/new");

    await page.getByLabel(/hospital number/i).fill(hospitalNumber);

    const initialsInput = page.getByLabel(/patient initials/i);
    await initialsInput.fill("mary jane");
    await initialsInput.blur();
    await expect(initialsInput).toHaveValue("MJ");

    // Fill the minimum required fields to save.
    const procedureField = page.getByLabel(/proposed procedure/i);
    if (await procedureField.count()) await procedureField.fill(procedure);

    // Predicted level of support is required by the server.
    const levelTrigger = page
      .getByRole("combobox")
      .filter({ hasText: /select|level/i })
      .first();
    if (await levelTrigger.count()) {
      await levelTrigger.click();
      await page
        .getByRole("option", { name: /Level 2 — HDU/ })
        .click()
        .catch(async () => {
          await page.getByRole("option", { name: /Level 2/i }).first().click();
        });
    }

    const isTest = page.getByLabel(/test|demonstration/i);
    if (await isTest.count()) {
      await isTest.first().check().catch(() => {});
    }

    await page
      .getByRole("button", { name: /save|create booking/i })
      .first()
      .click();

    // After save we land on the list or edit view; either way the row should
    // be findable, and its edit view must show the normalized initials.
    await page.waitForURL(/\/postop-bookings(\/|$)/, { timeout: 15_000 });

    // Open the row we just created — search by procedure text if listed.
    const row = page.getByText(procedure).first();
    if (await row.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await row.click();
    }

    // On the edit view the initials field must still be "MJ".
    const editInitials = page.getByLabel(/patient initials/i);
    await expect(editInitials).toHaveValue("MJ", { timeout: 10_000 });
  });

  test("bed-board partner-bridge edit auto-converts and round-trips", async ({
    page,
  }) => {
    await page.goto("/bed-board");

    const anyOccupied = page
      .locator('[role="button"][aria-label^="Bed "]')
      .filter({ hasNot: page.locator("text=Empty") })
      .first();

    if (!(await anyOccupied.isVisible({ timeout: 15_000 }).catch(() => false))) {
      test.skip(
        true,
        "No occupied beds visible — partner bridge likely offline in this env.",
      );
    }

    const bedLabel = (await anyOccupied.getAttribute("aria-label")) ?? "";
    const bedCode = bedLabel.match(/^Bed (\S+) — /)?.[1];
    expect(bedCode, "extract bed code from card").toBeTruthy();

    // Open the edit dialog.
    await anyOccupied.click();
    const dialog = page.getByRole("dialog", { name: /edit patient/i });
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    const initialsInput = dialog.getByLabel(/patient initials/i);
    await initialsInput.fill("Alice B Carter");
    await initialsInput.blur();
    await expect(initialsInput).toHaveValue("ABC");

    await dialog.getByRole("button", { name: /save changes/i }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // Round-trip: fully reload so we read fresh state from the partner bridge,
    // not the optimistic client cache.
    await page.reload();

    const card = page.getByRole("button", {
      name: new RegExp(`^Bed ${bedCode} — `),
    });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.click();

    const dialog2 = page.getByRole("dialog", { name: /edit patient/i });
    await expect(dialog2).toBeVisible({ timeout: 10_000 });
    await expect(dialog2.getByLabel(/patient initials/i)).toHaveValue("ABC", {
      timeout: 10_000,
    });
  });
});
