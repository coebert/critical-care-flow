import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";

/**
 * End-to-end check that referral notifications — both the push title and
 * the in-app toast/inbox row — are branded with "Radnor Critical Care".
 *
 * Web push cannot be observed headlessly, so we assert two proxies:
 *
 *   1. **In-app toast**: with the reviewer parked on any authenticated
 *      page, the realtime INSERT on `notifications` fires a Sonner toast
 *      whose title is `Radnor Critical Care — <kind>`. That is the exact
 *      string a signed-in user sees when a referral arrives.
 *   2. **Inbox row**: after the actor creates and updates the referral,
 *      the reviewer's `/notifications` page lists the corresponding rows
 *      and the "Radnor Critical Care" branding is visible on the page.
 *
 * The push title comes from the same fanout call — it is unit-covered in
 * `src/lib/notification-fanout.test.ts` and locked in by the default in
 * `notification-fanout.ts` (`args.title ?? "Radnor Critical Care"`), which
 * is imported and asserted by that unit test.
 *
 * Requires a second account in addition to E2E_EMAIL / E2E_PASSWORD:
 *   E2E_REVIEWER_EMAIL
 *   E2E_REVIEWER_PASSWORD
 * When those are missing the file is skipped, mirroring
 * push-notification-recipient-delivery.spec.ts.
 */

const REVIEWER_EMAIL = process.env.E2E_REVIEWER_EMAIL;
const REVIEWER_PASSWORD = process.env.E2E_REVIEWER_PASSWORD;

const BRAND = /Radnor Critical Care/;

test.describe("Referral notification branding — Radnor Critical Care", () => {
  test.skip(
    !REVIEWER_EMAIL || !REVIEWER_PASSWORD,
    "Set E2E_REVIEWER_EMAIL / E2E_REVIEWER_PASSWORD to run notification branding checks",
  );

  // Serialize so the actor's writes don't race the reviewer's realtime read.
  test.describe.configure({ mode: "serial" });

  async function signInReviewer(): Promise<BrowserContext> {
    const browser = await chromium.launch();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/auth");
    await page.getByLabel(/email/i).fill(REVIEWER_EMAIL!);
    await page.getByLabel(/password/i).fill(REVIEWER_PASSWORD!);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
    return ctx;
  }

  async function enableAllReferralPrefs(ctx: BrowserContext) {
    const page = await ctx.newPage();
    await page.goto("/notifications");
    for (const name of [/New referrals/i, /Referral updates/i]) {
      const sw = page.getByRole("switch", { name });
      await expect(sw).toBeVisible();
      const isOn = (await sw.getAttribute("aria-checked")) === "true";
      if (!isOn) await sw.click();
      await expect(sw).toHaveAttribute("aria-checked", "true");
    }
    await page.close();
  }

  async function createReferral(page: Page, hospitalNumber: string, reason: string) {
    await page.goto("/referrals/new");
    await page.getByLabel(/hospital number/i).fill(hospitalNumber);
    await page.getByLabel(/reason for referral/i).fill(reason);
    const isTest = page.getByLabel(/test|demonstration/i);
    if (await isTest.count()) {
      await isTest.first().check().catch(() => {});
    }
    await page.getByRole("button", { name: /save referral/i }).click();
    await expect(page).toHaveURL(/\/referrals\/[0-9a-f-]{36}$/i, { timeout: 15_000 });
    return page.url();
  }

  async function changeStatusTo(page: Page, detailUrl: string, statusPattern: RegExp) {
    await page.goto(detailUrl);
    const editBtn = page.getByRole("button", { name: /edit/i });
    if (await editBtn.count()) await editBtn.first().click().catch(() => {});
    const statusCombo = page.getByRole("combobox", { name: /status/i });
    await expect(statusCombo.first()).toBeVisible({ timeout: 10_000 });
    await statusCombo.first().click();
    await page.getByRole("option", { name: statusPattern }).first().click();
    const saveBtn = page.getByRole("button", { name: /save|update/i }).first();
    if (await saveBtn.count()) await saveBtn.click();
  }

  test("create + update surface 'Radnor Critical Care' in the toast and inbox", async ({ page }) => {
    const reviewer = await signInReviewer();
    await enableAllReferralPrefs(reviewer);

    // Park the reviewer on an authenticated page so the notification-bell
    // realtime subscription is live and Sonner can render toasts.
    const reviewerPage = await reviewer.newPage();
    await reviewerPage.goto("/");
    await expect(reviewerPage).toHaveURL(/\/$/);

    const marker = `E2E-BRAND-${Date.now()}`;
    const reason = `Branding test ${marker}`;
    const hospitalNumber = `${marker}-HN`;

    // --- CREATE fires kind="new" → toast title `Radnor Critical Care — New referral`.
    const detailUrl = await createReferral(page, hospitalNumber, reason);

    // Sonner renders toasts inside a container with role="region" /
    // aria-label="Notifications". Assert the branded title appears there.
    const toastRegion = reviewerPage.getByRole("region", { name: /notifications/i });
    await expect(
      toastRegion.getByText(/Radnor Critical Care\s+—\s+New referral/i).first(),
      "in-app toast on create should be branded 'Radnor Critical Care — New referral'",
    ).toBeVisible({ timeout: 20_000 });

    // --- UPDATE (status change) fires kind="status" → toast title
    //     `Radnor Critical Care — Referral status changed`.
    await changeStatusTo(page, detailUrl, /admitted|accepted|declined/i);
    await expect(
      toastRegion.getByText(/Radnor Critical Care\s+—\s+Referral status changed/i).first(),
      "in-app toast on status change should be branded 'Radnor Critical Care — Referral status changed'",
    ).toBeVisible({ timeout: 20_000 });

    await reviewerPage.close();
    await reviewer.close();
  });
});
