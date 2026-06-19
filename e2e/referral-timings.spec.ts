import { test, expect, type Page } from "@playwright/test";

/**
 * End-to-end coverage for ICNARC timestamp validation on the
 * new-referral form. Each test fills the form with a deliberately
 * invalid set of timestamps and asserts that:
 *   1. Saving is blocked (no navigation away from /referrals/new).
 *   2. A destructive toast is shown.
 *   3. The offending field(s) get the destructive border class.
 *   4. The "Inconsistent timings" alert is rendered when expected.
 */

const NEW = "/referrals/new";

// Format a JS Date for a <input type="datetime-local"> field.
const toLocal = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
};

const minutesFromNow = (m: number) => toLocal(new Date(Date.now() + m * 60_000));

async function fillDateTime(page: Page, label: RegExp | string, value: string) {
  // Each timestamp field is a Label + datetime-local input pair inside a
  // .space-y-1.5 wrapper, with a sibling "Now" button.
  const field = page.locator("div.space-y-1\\.5", { has: page.getByText(label) });
  await field.locator('input[type="datetime-local"]').fill(value);
}

async function clearDateTime(page: Page, label: RegExp | string) {
  const field = page.locator("div.space-y-1\\.5", { has: page.getByText(label) });
  await field.locator('input[type="datetime-local"]').fill("");
}

async function setStatus(page: Page, status: "Pending" | "Admitted" | "Declined") {
  await page
    .locator("div.space-y-1\\.5", { has: page.getByText(/^Status$/) })
    .getByRole("combobox")
    .click();
  await page.getByRole("option", { name: status }).click();
}

async function expectInvalid(page: Page, label: RegExp | string) {
  const input = page
    .locator("div.space-y-1\\.5", { has: page.getByText(label) })
    .locator('input[type="datetime-local"]');
  await expect(input).toHaveClass(/border-destructive/);
}

async function expectValid(page: Page, label: RegExp | string) {
  const input = page
    .locator("div.space-y-1\\.5", { has: page.getByText(label) })
    .locator('input[type="datetime-local"]');
  await expect(input).not.toHaveClass(/border-destructive/);
}

test.describe("ICNARC referral timing validation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(NEW);
    await expect(page.getByRole("heading", { name: /new referral/i })).toBeVisible();
  });

  test("missing referral_received_at blocks save (pending)", async ({ page }) => {
    await clearDateTime(page, /^Referral received$/);

    await page.getByRole("button", { name: /save referral/i }).click();

    // No navigation
    await expect(page).toHaveURL(new RegExp(NEW + "$"));
    // Destructive toast appears
    await expect(page.getByText(/fix the highlighted timing fields/i)).toBeVisible();
    // Field is highlighted
    await expectInvalid(page, /^Referral received$/);
  });

  test("admitted requires first seen, decision, and arrival", async ({ page }) => {
    // Keep referral_received_at populated (it auto-fills with localISO())
    await setStatus(page, "Admitted");
    // Leave first seen / decision / arrived empty
    await page.getByRole("button", { name: /save referral/i }).click();

    await expect(page).toHaveURL(new RegExp(NEW + "$"));
    await expect(page.getByText(/fix the highlighted timing fields/i)).toBeVisible();

    await expectInvalid(page, /^First seen by CC$/);
    await expectInvalid(page, /^Decision to admit \/ decline$/);
    await expectInvalid(page, /^Arrived on unit$/);
    await expectValid(page, /^Referral received$/);
  });

  test("future timestamps are rejected", async ({ page }) => {
    // +1 day in the future, well beyond the 2-minute skew cap.
    await fillDateTime(page, /^Referral received$/, minutesFromNow(60 * 24));

    await page.getByRole("button", { name: /save referral/i }).click();

    await expect(page).toHaveURL(new RegExp(NEW + "$"));
    await expectInvalid(page, /^Referral received$/);
    await expect(page.getByText(/cannot be in the future/i)).toBeVisible();
  });

  test("future first-seen on an admitted referral is rejected", async ({ page }) => {
    await setStatus(page, "Admitted");
    await fillDateTime(page, /^Referral received$/, minutesFromNow(-120));
    await fillDateTime(page, /^First seen by CC$/, minutesFromNow(60 * 24));
    await fillDateTime(page, /^Decision to admit \/ decline$/, minutesFromNow(-60));
    await fillDateTime(page, /^Arrived on unit$/, minutesFromNow(-30));

    await page.getByRole("button", { name: /save referral/i }).click();

    await expect(page).toHaveURL(new RegExp(NEW + "$"));
    await expectInvalid(page, /^First seen by CC$/);
  });

  test("first seen before received is flagged and listed in the alert", async ({ page }) => {
    await setStatus(page, "Declined");
    await fillDateTime(page, /^Referral received$/, minutesFromNow(-30));
    await fillDateTime(page, /^First seen by CC$/, minutesFromNow(-60));
    await fillDateTime(page, /^Decision to admit \/ decline$/, minutesFromNow(-10));
    // Declined → decline reason required by the UI but not by timing validator;
    // the form should still block on the timing issue first.

    await page.getByRole("button", { name: /save referral/i }).click();

    await expect(page).toHaveURL(new RegExp(NEW + "$"));
    await expectInvalid(page, /^First seen by CC$/);
    await expect(page.getByText(/Inconsistent timings/i)).toBeVisible();
    await expect(
      page.getByText(/first seen.*before.*referral was received/i),
    ).toBeVisible();
  });

  test("decision before first seen is flagged", async ({ page }) => {
    await setStatus(page, "Declined");
    await fillDateTime(page, /^Referral received$/, minutesFromNow(-90));
    await fillDateTime(page, /^First seen by CC$/, minutesFromNow(-30));
    await fillDateTime(page, /^Decision to admit \/ decline$/, minutesFromNow(-60));

    await page.getByRole("button", { name: /save referral/i }).click();

    await expect(page).toHaveURL(new RegExp(NEW + "$"));
    await expectInvalid(page, /^Decision to admit \/ decline$/);
    await expect(page.getByText(/decision.*before.*first seen/i)).toBeVisible();
  });

  test("arrival before decision (admitted) is flagged", async ({ page }) => {
    await setStatus(page, "Admitted");
    await fillDateTime(page, /^Referral received$/, minutesFromNow(-120));
    await fillDateTime(page, /^First seen by CC$/, minutesFromNow(-90));
    await fillDateTime(page, /^Decision to admit \/ decline$/, minutesFromNow(-30));
    await fillDateTime(page, /^Arrived on unit$/, minutesFromNow(-60));

    await page.getByRole("button", { name: /save referral/i }).click();

    await expect(page).toHaveURL(new RegExp(NEW + "$"));
    await expectInvalid(page, /^Arrived on unit$/);
    await expect(page.getByText(/arrived.*before.*decision/i)).toBeVisible();
  });

  test("a fully valid, chronological admitted referral does not show timing errors", async ({
    page,
  }) => {
    await setStatus(page, "Admitted");
    await fillDateTime(page, /^Referral received$/, minutesFromNow(-120));
    await fillDateTime(page, /^First seen by CC$/, minutesFromNow(-90));
    await fillDateTime(page, /^Decision to admit \/ decline$/, minutesFromNow(-60));
    await fillDateTime(page, /^Arrived on unit$/, minutesFromNow(-30));

    // We don't actually submit — that would create a real DB row. We just
    // assert that there are no destructive borders on the timing fields.
    await expectValid(page, /^Referral received$/);
    await expectValid(page, /^First seen by CC$/);
    await expectValid(page, /^Decision to admit \/ decline$/);
    await expectValid(page, /^Arrived on unit$/);
    await expect(page.getByText(/Inconsistent timings/i)).toHaveCount(0);
  });
});
