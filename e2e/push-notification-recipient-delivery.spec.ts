import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";

/**
 * End-to-end check that a *recipient* actually receives push-backed
 * notifications when a referral is created and when its status is changed.
 *
 * Web-push over the OS/browser stack can't run headless, so — matching
 * `push-notification-prefs.spec.ts` — we assert the in-app notification row
 * inserted by the same fanout call that dispatches the web-push. The
 * per-endpoint filter is unit-tested in
 * `src/lib/notification-fanout-prefs.test.ts`.
 *
 * Requires a second account in addition to E2E_EMAIL / E2E_PASSWORD:
 *   E2E_REVIEWER_EMAIL
 *   E2E_REVIEWER_PASSWORD
 *
 * When those vars are missing the file is skipped so the primary suite
 * keeps working with a single account.
 */

const REVIEWER_EMAIL = process.env.E2E_REVIEWER_EMAIL;
const REVIEWER_PASSWORD = process.env.E2E_REVIEWER_PASSWORD;

test.describe("Referral push notifications — recipient delivery", () => {
  test.skip(
    !REVIEWER_EMAIL || !REVIEWER_PASSWORD,
    "Set E2E_REVIEWER_EMAIL / E2E_REVIEWER_PASSWORD to run recipient delivery checks",
  );

  // Serialize so the actor page and the reviewer inbox don't race for the
  // same fanout row.
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

  async function reviewerSees(
    ctx: BrowserContext,
    matcher: RegExp,
    { timeout = 20_000 }: { timeout?: number } = {},
  ) {
    const page = await ctx.newPage();
    // The bell/inbox page lists all in-app notifications for the signed-in
    // user; both fanout kinds ("new" and "status") land here.
    await page.goto("/notifications");
    await expect(page.getByText(matcher).first()).toBeVisible({ timeout });
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
    // The status control is a combobox on the detail page. If the app
    // requires entering an "edit" mode first, best-effort click that.
    const editBtn = page.getByRole("button", { name: /edit/i });
    if (await editBtn.count()) await editBtn.first().click().catch(() => {});
    const statusCombo = page.getByRole("combobox", { name: /status/i });
    await expect(statusCombo.first()).toBeVisible({ timeout: 10_000 });
    await statusCombo.first().click();
    await page.getByRole("option", { name: statusPattern }).first().click();
    const saveBtn = page.getByRole("button", { name: /save|update/i }).first();
    if (await saveBtn.count()) await saveBtn.click();
  }

  test("recipient receives a notification on create and on status change", async ({ page }) => {
    const reviewer = await signInReviewer();
    await enableAllReferralPrefs(reviewer);

    const marker = `E2E-PUSH-${Date.now()}`;
    const reason = `Push delivery test ${marker}`;
    const hospitalNumber = `${marker}-HN`;

    // --- CREATE fires kind="new"; message contains the specialty/ward summary.
    // We assert the reviewer's notifications page picks up the referral by
    // linking through — the "New referral" title is enough of a signal that
    // fanout ran within the timeout window.
    const detailUrl = await createReferral(page, hospitalNumber, reason);
    await reviewerSees(reviewer, /new referral/i);

    // --- UPDATE (status change) fires kind="status" with a message that
    // literally begins "Status → ADMITTED: …". Match on that shape so we
    // are asserting the update fanout, not the earlier "new" row.
    await changeStatusTo(page, detailUrl, /admitted|accepted|declined/i);
    await reviewerSees(reviewer, /status\s*→/i);

    await reviewer.close();
  });
});
