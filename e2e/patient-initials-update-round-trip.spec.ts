import { test, expect } from "@playwright/test";

/**
 * Update patient initials on an existing referral, and confirm the value
 * round-trips through the bed board and the partner bridge on reload.
 *
 * The deterministic leg exercises the referral update path:
 *   1. Create a fixture referral with initials "AB".
 *   2. Re-open it, type a full name into the initials input, blur to force
 *      normalisation, save, then hard-reload the detail page and confirm
 *      the persisted value is the normalised initials (not the full name).
 *
 * The bed-board / partner-bridge leg is only meaningful when the partner
 * bridge is online and there is an occupied bed to edit. When either is
 * absent we skip rather than fail:
 *   3. Open the edit dialog for an occupied bed, type a full name into the
 *      "Patient initials" field, blur → normalised, save, close.
 *   4. Full-page reload the bed board (bypasses optimistic cache; re-reads
 *      from the local mirror which is fed by the partner bridge). Confirm
 *      the bed card's aria-label shows the normalised initials.
 *   5. Re-open the dialog and confirm the input still holds the normalised
 *      value — this is what the partner would echo back on the next sync.
 */

const uniqueHospitalNumber = () =>
  `E2E-REFUPD-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

test.describe("patient initials update round-trip", () => {
  test("referral edit persists normalised initials on reload", async ({
    page,
  }) => {
    const hospitalNumber = uniqueHospitalNumber();
    const reason = `Playwright referral-update ${hospitalNumber}`;

    // --- Create fixture ---
    await page.goto("/referrals/new");
    await page.getByLabel(/hospital number/i).fill(hospitalNumber);
    await page.getByLabel(/reason for referral/i).fill(reason);

    const initialsCreate = page.getByLabel(/patient initials/i);
    await initialsCreate.fill("AB");
    await initialsCreate.blur();
    await expect(initialsCreate).toHaveValue("AB");

    const isTest = page.getByLabel(/test|demonstration/i);
    if (await isTest.count()) {
      await isTest.first().check().catch(() => {});
    }

    await page.getByRole("button", { name: /save referral/i }).click();
    await expect(page).toHaveURL(/\/referrals\/[0-9a-f-]{36}$/i, {
      timeout: 15_000,
    });
    const detailUrl = page.url();

    // --- Update initials with a full name ---
    await page.goto(detailUrl);
    const initialsEdit = page.getByLabel(/patient initials/i);
    await expect(initialsEdit).toHaveValue("AB", { timeout: 10_000 });

    await initialsEdit.fill("Robert F Kennedy");
    await initialsEdit.blur();
    await expect(initialsEdit).toHaveValue("RFK");

    // Save via whatever save affordance is on the detail form.
    await page
      .getByRole("button", { name: /save (changes|referral)/i })
      .first()
      .click();

    // Wait for the save to settle. Some detail views stay on the page and
    // just toast; others navigate. Either way the input should read "RFK"
    // after a hard reload.
    await page.waitForTimeout(500);
    await page.goto(detailUrl);
    await expect(page.getByLabel(/patient initials/i)).toHaveValue("RFK", {
      timeout: 15_000,
    });
  });

  test("bed-board edit round-trips through the partner bridge on reload", async ({
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
    const cardSel = () =>
      page.getByRole("button", { name: new RegExp(`^Bed ${bedCode} — `) });

    // Capture baseline so we can restore it at the end (best effort).
    const baselineLabel = bedLabel;
    const baselineInitials =
      baselineLabel.match(/^Bed \S+ — (.+)$/)?.[1]?.trim() ?? "";

    const NEW_FULL_NAME = "Alice B Carter";
    const NEW_INITIALS = "ABC";

    // Open dialog, set full name, blur normalises → "ABC", save.
    await cardSel().click();
    let dialog = page.getByRole("dialog", { name: /edit patient/i });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    const dialogInitials = dialog.getByLabel(/patient initials/i);
    await dialogInitials.fill(NEW_FULL_NAME);
    await dialogInitials.blur();
    await expect(dialogInitials).toHaveValue(NEW_INITIALS);
    await dialog.getByRole("button", { name: /save changes/i }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // Hard reload — bypasses in-flight optimistic state and re-reads from
    // the local mirror that the partner bridge feeds.
    await page.reload();

    // Bed card reflects the change.
    const reloadedCard = cardSel();
    await expect(reloadedCard).toBeVisible({ timeout: 15_000 });
    await expect(reloadedCard).toHaveAttribute(
      "aria-label",
      new RegExp(`^Bed ${bedCode} — .*${NEW_INITIALS}`),
      { timeout: 15_000 },
    );

    // Re-opening the dialog after reload proves the value round-tripped
    // through the partner-facing update path, not just optimistic state.
    await reloadedCard.click();
    dialog = page.getByRole("dialog", { name: /edit patient/i });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByLabel(/patient initials/i)).toHaveValue(
      NEW_INITIALS,
      { timeout: 10_000 },
    );

    // Best-effort restore so we don't leave the shared unit dirty. Only
    // restore if the baseline itself was already initials-shaped (i.e.
    // 1–10 uppercase letters); otherwise the strict validator would just
    // re-normalise it and defeat the point.
    if (/^[A-Z]{1,10}$/.test(baselineInitials)) {
      const restoreInput = dialog.getByLabel(/patient initials/i);
      await restoreInput.fill(baselineInitials);
      await restoreInput.blur();
      await dialog
        .getByRole("button", { name: /save changes/i })
        .click()
        .catch(() => {});
      await expect(dialog).toBeHidden({ timeout: 15_000 }).catch(() => {});
    }
  });
});
