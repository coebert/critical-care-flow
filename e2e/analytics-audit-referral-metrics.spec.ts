import { test, expect } from "@playwright/test";

/**
 * Verifies the Analytics → Referrals ("Audit") tab renders the core
 * referral metrics expected by the critical-care team:
 *
 *   - "Referrals over time" chart (referral counts across the range)
 *   - "Mean / 24h" KPI       (mean referrals per 24 hours)
 *   - "Referrals by specialty (top 10)" chart + specialty breakdown table
 *   - "Mean age (yrs)" KPI
 *
 * The Supabase REST call for `referrals` is intercepted so the assertions
 * are deterministic and don't depend on live data.
 */

const ANALYTICS_URL = "/analytics";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const isoDaysAgo = (n: number) => new Date(now - n * DAY).toISOString();

function row(overrides: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    deleted_at: null,
    status: "pending",
    age: 50,
    sex: "male",
    referring_specialty: "Medicine",
    admission_urgency: "within_1_hour",
    referral_received_at: isoDaysAgo(1),
    first_seen_at: null,
    decision_at: null,
    arrived_on_unit_at: null,
    ...overrides,
  };
}

// Mixed dataset: two specialties, known ages, spread across the default range.
const MOCK_REFERRALS = [
  row({ referring_specialty: "Medicine", age: 40, referral_received_at: isoDaysAgo(1) }),
  row({ referring_specialty: "Medicine", age: 60, referral_received_at: isoDaysAgo(2) }),
  row({ referring_specialty: "Medicine", age: 80, referral_received_at: isoDaysAgo(3) }),
  row({ referring_specialty: "Surgery",  age: 30, referral_received_at: isoDaysAgo(4) }),
  row({ referring_specialty: "Surgery",  age: 70, referral_received_at: isoDaysAgo(5) }),
];

test.describe("analytics — referral audit metrics", () => {
  test.beforeEach(async ({ page }) => {
    await page.route(/\/rest\/v1\/referrals(\?|$)/, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {
          "content-range": `0-${MOCK_REFERRALS.length - 1}/${MOCK_REFERRALS.length}`,
        },
        body: JSON.stringify(MOCK_REFERRALS),
      });
    });
  });

  test("renders referral counts over time, mean/24h, by specialty, and mean age", async ({ page }) => {
    await page.goto(ANALYTICS_URL);

    // Total referrals KPI proves the fixture reached the panel.
    await expect(
      page.locator("div", { hasText: /^Total referrals$/i }).first()
    ).toBeVisible();
    await expect(
      page
        .locator("div.text-2xl.font-semibold", { hasText: String(MOCK_REFERRALS.length) })
        .first()
    ).toBeVisible({ timeout: 15_000 });

    // ---- Referral counts over time --------------------------------------
    const overTimeCard = page.locator("div.p-5").filter({
      has: page.getByRole("heading", { name: /^Referrals over time$/ }),
    }).first();
    await expect(overTimeCard).toBeVisible();
    // Chart renders at least one x-axis tick from the day series.
    await expect(
      overTimeCard.locator(".recharts-xAxis .recharts-cartesian-axis-tick-value").first()
    ).toBeVisible();

    // ---- Mean / 24h KPI --------------------------------------------------
    const meanPer24hCard = page
      .locator("div", { hasText: /^Mean \/ 24h$/ })
      .first();
    await expect(meanPer24hCard).toBeVisible();
    // Value should be a non-negative number (e.g. "0.2" for 5 rows over 30d).
    const meanPer24hValue = await meanPer24hCard
      .locator("xpath=following-sibling::*[1]")
      .innerText()
      .catch(() => "");
    expect(meanPer24hValue).toMatch(/^\d+(\.\d+)?$/);
    expect(Number(meanPer24hValue)).toBeGreaterThan(0);

    // ---- Mean age KPI ----------------------------------------------------
    // Fixture mean age = (40+60+80+30+70)/5 = 56.0
    const meanAgeCard = page
      .locator("div", { hasText: /^Mean age \(yrs\)$/ })
      .first();
    await expect(meanAgeCard).toBeVisible();
    const meanAgeValue = await meanAgeCard
      .locator("xpath=following-sibling::*[1]")
      .innerText()
      .catch(() => "");
    expect(meanAgeValue).toBe("56.0");

    // ---- Referrals by specialty ------------------------------------------
    const bySpecialtyCard = page.locator("div.p-5").filter({
      has: page.getByRole("heading", { name: /^Referrals by specialty \(top 10\)$/ }),
    }).first();
    await expect(bySpecialtyCard).toBeVisible();

    const specialtyTicks = await bySpecialtyCard
      .locator(".recharts-xAxis .recharts-cartesian-axis-tick-value")
      .allInnerTexts();
    expect(new Set(specialtyTicks.map((s) => s.trim()))).toEqual(
      new Set(["Medicine", "Surgery"])
    );

    // Specialty breakdown table shows the correct per-specialty counts.
    const breakdownCard = page.locator("div.p-5").filter({
      has: page.getByRole("heading", { name: /^Specialty breakdown$/ }),
    }).first();

    const medicineRow = breakdownCard.locator("tr", { hasText: /^Medicine/ }).first();
    await expect(medicineRow).toContainText("3");
    await expect(medicineRow).toContainText("60.0 yrs"); // (40+60+80)/3

    const surgeryRow = breakdownCard.locator("tr", { hasText: /^Surgery/ }).first();
    await expect(surgeryRow).toContainText("2");
    await expect(surgeryRow).toContainText("50.0 yrs"); // (30+70)/2
  });
});
