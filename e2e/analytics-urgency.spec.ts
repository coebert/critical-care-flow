import { test, expect } from "@playwright/test";

/**
 * Integration coverage for the analytics page rendering. We intercept the
 * Supabase REST request for `referrals` and return a mixed-quality dataset
 * containing:
 *
 *   - rows with valid urgencies (within_15_min, within_1_hour)
 *   - rows with null admission_urgency
 *   - a row with an unknown / legacy urgency string
 *   - rows with missing or invalid referral_received_at
 *
 * We then assert that:
 *   - the "Total referrals" KPI counts only rows with valid receive dates
 *   - the urgency counts list shows the labels we expect with the right totals
 *   - the bar chart x-axis ticks match the counts list
 *   - the stacked area legend always shows every URGENCY_DISPLAY_ORDER label
 *   - axis labels and counts use the same canonical labels (no raw enum
 *     values like "within_15_min" or "legacy_value" leak into the UI)
 */

const ANALYTICS_URL = "/analytics";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const isoDaysAgo = (n: number) => new Date(now - n * DAY).toISOString();

function baseRow(overrides: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    deleted_at: null,
    status: "pending",
    age: 60,
    sex: "male",
    referring_specialty: "Medicine",
    first_seen_at: null,
    decision_at: null,
    arrived_on_unit_at: null,
    admission_urgency: null,
    referral_received_at: isoDaysAgo(1),
    ...overrides,
  };
}

const MOCK_REFERRALS = [
  // 3x within_15_min (today)
  baseRow({ admission_urgency: "within_15_min", referral_received_at: isoDaysAgo(0) }),
  baseRow({ admission_urgency: "within_15_min", referral_received_at: isoDaysAgo(0) }),
  baseRow({ admission_urgency: "within_15_min", referral_received_at: isoDaysAgo(1) }),
  // 2x within_1_hour (5 days ago)
  baseRow({ admission_urgency: "within_1_hour", referral_received_at: isoDaysAgo(5) }),
  baseRow({ admission_urgency: "within_1_hour", referral_received_at: isoDaysAgo(5) }),
  // 2x null urgency
  baseRow({ admission_urgency: null, referral_received_at: isoDaysAgo(2) }),
  baseRow({ admission_urgency: null, referral_received_at: isoDaysAgo(3) }),
  // 1x legacy / unknown urgency string
  baseRow({ admission_urgency: "legacy_value", referral_received_at: isoDaysAgo(4) }),
  // Invalid / missing receive dates — should be dropped by the page filter
  baseRow({ admission_urgency: "within_30_min", referral_received_at: null }),
  baseRow({ admission_urgency: "within_30_min", referral_received_at: "not-a-date" }),
];

// Rows that survive the page's `from <= referral_received_at <= to` filter.
const VALID_ROW_COUNT = 8;

const EXPECTED_COUNTS: Record<string, number> = {
  "Within 15 minutes": 3,
  "Within 1 hour": 2,
  "Not set": 3, // 2 nulls + 1 unknown enum -> "Not set"
};

const ALL_LEGEND_LABELS = [
  "Within 15 minutes",
  "Within 30 minutes",
  "Within 1 hour",
  "Within 1–2 hours",
  "N/A (decision not to admit)",
  "Not set",
];

test.describe("analytics page — mixed-quality urgency dataset", () => {
  test.beforeEach(async ({ page }) => {
    // Intercept the PostgREST call for `referrals` and return our fixture.
    await page.route(/\/rest\/v1\/referrals(\?|$)/, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "content-range": `0-${MOCK_REFERRALS.length - 1}/${MOCK_REFERRALS.length}` },
        body: JSON.stringify(MOCK_REFERRALS),
      });
    });
  });

  test("legend, axis labels, and counts stay aligned for the selected range", async ({ page }) => {
    await page.goto(ANALYTICS_URL);

    // Wait for header KPI to render with the filtered total.
    const totalCard = page.locator("div", { hasText: /^Total referrals$/i }).first();
    await expect(totalCard).toBeVisible();
    await expect(
      page.locator("div.text-2xl.font-semibold", { hasText: String(VALID_ROW_COUNT) }).first()
    ).toBeVisible({ timeout: 15_000 });

    // ---- Counts list -----------------------------------------------------
    const countsCard = page.locator("section, div").filter({
      has: page.getByRole("heading", { name: /^Urgency counts$/ }),
    }).first();

    for (const [label, count] of Object.entries(EXPECTED_COUNTS)) {
      const row = countsCard.locator("li", { hasText: label });
      await expect(row).toBeVisible();
      await expect(row).toContainText(String(count));
    }

    // No raw enum values should ever leak into the counts list.
    await expect(countsCard).not.toContainText("within_15_min");
    await expect(countsCard).not.toContainText("legacy_value");

    // Counts list rows match exactly the labels we expect.
    const renderedCountLabels = await countsCard
      .locator("li > span.text-muted-foreground")
      .allInnerTexts();
    expect(renderedCountLabels.map((s) => s.trim())).toEqual(Object.keys(EXPECTED_COUNTS));

    // Totals across the counts list equal the number of valid-date rows.
    const totalFromCounts = Object.values(EXPECTED_COUNTS).reduce((a, b) => a + b, 0);
    expect(totalFromCounts).toBe(VALID_ROW_COUNT);

    // ---- Bar chart x-axis ------------------------------------------------
    const barCard = page.locator("div.p-5").filter({
      has: page.getByRole("heading", { name: /^Admission urgency$/ }),
    }).first();

    const axisTicks = await barCard
      .locator(".recharts-xAxis .recharts-cartesian-axis-tick-value")
      .allInnerTexts();

    expect(new Set(axisTicks.map((s) => s.trim()))).toEqual(new Set(Object.keys(EXPECTED_COUNTS)));

    // ---- Stacked area legend --------------------------------------------
    const stackedCard = page.locator("div.p-5").filter({
      has: page.getByRole("heading", { name: /^Referrals over time by urgency$/ }),
    }).first();

    const legendItems = await stackedCard
      .locator(".recharts-legend-item-text")
      .allInnerTexts();

    // Every canonical label is present, in canonical order.
    expect(legendItems.map((s) => s.trim())).toEqual(ALL_LEGEND_LABELS);
  });
});
