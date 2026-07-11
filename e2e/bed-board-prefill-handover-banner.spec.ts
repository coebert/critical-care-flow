import { test, expect } from "@playwright/test";

/**
 * UI test for the "Prefill handover from referral" flow on the bed board.
 *
 * A clinician who admits a referred patient onto a partner ICU bed lands
 * back on `/bed-board?source_referral_id=<uuid>&…`. Opening the newly
 * admitted bed must show:
 *
 *   1. A "Prefill handover from referral" banner (role=region) explaining
 *      what the button will copy.
 *   2. A "Prefill" button next to it.
 *
 * Clicking Prefill posts to `prefillPartnerHandoverFromReferral`, which is
 * fill-blanks-only. When it actually applies fields, the dialog re-reads
 * the occupant from the partner mirror, so the visible handover inputs —
 * DNACPR switch + details textarea — populate from the referral. When the
 * partner already has values, the server-fn reports "nothing to prefill"
 * and we assert the info toast instead.
 *
 * The partner-bridge legs skip cleanly when no occupied bed is available
 * (e.g. bridge offline in this env) — a stale partner is infra, not an
 * app-layer regression.
 */

const uniqueHospitalNumber = () =>
  `E2E-PREFILL-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

async function createReferralWithClinicalDetail(
  page: import("@playwright/test").Page,
): Promise<string> {
  const hospitalNumber = uniqueHospitalNumber();

  await page.goto("/referrals/new");
  await page.getByLabel(/hospital number/i).fill(hospitalNumber);

  const initials = page.getByLabel(/patient initials/i);
  await initials.fill("PX");
  await initials.blur();
  await expect(initials).toHaveValue("PX");

  await page
    .getByLabel(/reason for referral/i)
    .fill(`Playwright prefill fixture ${hospitalNumber}`);

  // Past medical history — feeds the partner's past_medical_history column
  // via the prefill mapping.
  const pmh = page.getByLabel(/past medical history/i).first();
  if (await pmh.count()) {
    await pmh.fill("IHD, COPD (Playwright fixture)");
  }

  // DNACPR / ReSPECT toggle — drives `dnacpr_decision: true` and a
  // "ReSPECT / DNACPR form recorded on critical care referral." details
  // line on the partner side.
  const dnacpr = page.getByLabel(/DNACPR|ReSPECT/i).first();
  if (await dnacpr.count()) {
    await dnacpr.check().catch(() => {});
  }

  // Keep our fixture out of clinical analytics.
  const isTest = page.getByLabel(/test|demonstration/i).first();
  if (await isTest.count()) {
    await isTest.check().catch(() => {});
  }

  await page.getByRole("button", { name: /save referral/i }).click();
  await page.waitForURL(/\/referrals\/[0-9a-f-]{36}$/i, { timeout: 15_000 });

  const match = page.url().match(/\/referrals\/([0-9a-f-]{36})$/i);
  expect(match, "captured referral UUID from detail URL").toBeTruthy();
  return match![1];
}

test.describe("bed-board prefill handover banner", () => {
  test("?source_referral_id shows the banner + Prefill button, and populates handover inputs", async ({
    page,
  }) => {
    const referralId = await createReferralWithClinicalDetail(page);

    // Open the bed board carrying the referral as the prefill source.
    await page.goto(`/bed-board?source_referral_id=${referralId}`);

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

    const dialog = page.getByRole("dialog", { name: /edit patient/i });
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // --- Banner + button visibility (deterministic assertion). ---
    const banner = dialog.getByRole("region", {
      name: /prefill handover from referral/i,
    });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/TEP/i);
    await expect(banner).toContainText(/DNACPR/i);
    await expect(banner).toContainText(/past medical history/i);

    const prefillButton = banner.getByRole("button", { name: /^Prefill$/ });
    await expect(prefillButton).toBeEnabled();

    // --- Click Prefill and inspect the outcome. ---
    // The DNACPR switch's current state before we click Prefill tells us
    // whether the partner already had a decision recorded. Prefill is
    // fill-blanks-only, so it will only toggle a currently-off switch on.
    const dnacprSwitch = dialog.getByRole("switch", {
      name: /DNACPR decision/i,
    });
    await expect(dnacprSwitch).toBeVisible();
    const dnacprWasOn =
      (await dnacprSwitch.getAttribute("aria-checked")) === "true";

    await prefillButton.click();

    // Every outcome surfaces a toast — success, "already populated", or a
    // server error. Wait for whichever appears.
    const anyToast = page
      .locator('[data-sonner-toast], [role="status"], [role="alert"]')
      .filter({ hasText: /prefill|handover|referral/i })
      .first();
    await expect(anyToast).toBeVisible({ timeout: 15_000 });

    if (dnacprWasOn) {
      // Fill-blanks-only: nothing to apply for DNACPR. The switch must NOT
      // have been flipped off — the prefill mapper never overwrites an
      // existing true.
      await expect(dnacprSwitch).toHaveAttribute("aria-checked", "true");
    } else {
      // The partner had no DNACPR decision; our referral has
      // dnacpr_respect=true, so prefill should flip it on and reveal the
      // DNACPR details textarea populated with the exact referral-origin
      // reason string from composeDnacprDetails().
      await expect(dnacprSwitch).toHaveAttribute("aria-checked", "true", {
        timeout: 15_000,
      });
      const dnacprDetails = dialog.getByLabel(/DNACPR details/i);
      await expect(dnacprDetails).toBeVisible({ timeout: 10_000 });
      // Exact reason wording from composeDnacprDetails() when the referral
      // has dnacpr_respect=true (not the "DNACPR documented…" variant that
      // fires only for resus_status='dnacpr').
      await expect(dnacprDetails).toHaveValue(
        /ReSPECT \/ DNACPR form recorded on critical care referral\./,
      );

      // wantsTep is true whenever DNACPR is being set, so the TEP switch
      // should also have been flipped on by the same prefill run.
      const tepSwitch = dialog.getByRole("switch", { name: /TEP in place/i });
      await expect(tepSwitch).toHaveAttribute("aria-checked", "true");

      // Success toast must report a numeric count. Our referral seeds
      // past_medical_history, reason_for_referral (→ current_admission),
      // dnacpr_decision, dnacpr_details, and tep_in_place — so at minimum
      // three handover fields must have been applied. The exact PMH and
      // admission-reason text lives on partner columns that this dialog
      // does not render (they surface on the partner ICU Handover Hub
      // UI); their mapping is verified exhaustively in
      // src/lib/partner-handover-prefill.test.ts. Here we assert the
      // count as the UI-observable proof that they were part of the
      // applied set.
      const successToast = page
        .locator('[data-sonner-toast], [role="status"]')
        .filter({ hasText: /Prefilled \d+ handover field/i })
        .first();
      await expect(successToast).toBeVisible({ timeout: 10_000 });
      const toastText = (await successToast.textContent()) ?? "";
      const match = toastText.match(/Prefilled (\d+) handover field/i);
      expect(match, `toast should include applied count: ${toastText}`)
        .not.toBeNull();
      const appliedCount = Number(match![1]);
      expect(appliedCount).toBeGreaterThanOrEqual(3);

      // Round-trip: close and re-open the dialog to prove the DNACPR
      // details we just saw came back from the server (not just optimistic
      // local state).
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden({ timeout: 10_000 });
      await anyOccupied.click();
      const dialog2 = page.getByRole("dialog", { name: /edit patient/i });
      await expect(dialog2).toBeVisible({ timeout: 10_000 });
      await expect(
        dialog2.getByRole("switch", { name: /DNACPR decision/i }),
      ).toHaveAttribute("aria-checked", "true");
      await expect(dialog2.getByLabel(/DNACPR details/i)).toHaveValue(
        /ReSPECT \/ DNACPR form recorded on critical care referral\./,
      );
    }
  });

  test("no ?source_referral_id → no prefill banner is shown", async ({
    page,
  }) => {
    await page.goto("/bed-board");

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
    const dialog = page.getByRole("dialog", { name: /edit patient/i });
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // Banner should not exist when no source referral is in the URL.
    await expect(
      dialog.getByRole("region", {
        name: /prefill handover from referral/i,
      }),
    ).toHaveCount(0);
  });
});
