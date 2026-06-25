import { describe, it, expect } from "vitest";
import { eachDayOfInterval, format, startOfDay, subDays, endOfDay } from "date-fns";
import {
  aggregateUrgencyCounts,
  aggregateUrgencyPerDay,
  URGENCY_LEGEND_KEYS,
  type UrgencyRow,
} from "./analytics-urgency";
import { URGENCY_DISPLAY_ORDER, URGENCY_NOT_SET_LABEL } from "./admission-urgency";

/**
 * Integration test for the analytics page urgency surfaces.
 *
 * Renders the same data the page renders by exercising the exact
 * aggregators wired into <BarChart>, <AreaChart>, and the counts
 * <ul>, and asserts the labels surfaced as
 *   - bar chart X-axis ticks   (byUrgency[].urgency)
 *   - counts list rows         (byUrgency[].urgency)
 *   - stacked-area legend keys (URGENCY_LEGEND_KEYS, fed to <Area dataKey>)
 *   - stacked-area data keys   (Object.keys(perDayByUrgency[i]) minus "date")
 * stay aligned with each other and with the canonical
 * URGENCY_DISPLAY_ORDER.
 */
describe("analytics urgency surfaces alignment", () => {
  const to = endOfDay(new Date("2026-06-25T12:00:00Z"));
  const from = startOfDay(subDays(to, 6)); // 7-day window
  const dayKeys = eachDayOfInterval({ start: from, end: to }).map((d) =>
    format(d, "yyyy-MM-dd")
  );

  // Realistic mixed dataset across the window — every urgency + nulls
  // sprinkled across multiple days, including a day with zero referrals.
  const rows: UrgencyRow[] = [
    { admission_urgency: "within_15_min",  referral_received_at: `${dayKeys[0]}T08:00:00Z` },
    { admission_urgency: "within_15_min",  referral_received_at: `${dayKeys[1]}T09:00:00Z` },
    { admission_urgency: "within_30_min",  referral_received_at: `${dayKeys[1]}T10:00:00Z` },
    { admission_urgency: "within_1_hour",  referral_received_at: `${dayKeys[2]}T11:00:00Z` },
    { admission_urgency: "within_1_2_hours", referral_received_at: `${dayKeys[3]}T12:00:00Z` },
    { admission_urgency: "not_admitting",  referral_received_at: `${dayKeys[4]}T13:00:00Z` },
    { admission_urgency: "not_admitting",  referral_received_at: `${dayKeys[4]}T14:00:00Z` },
    { admission_urgency: null,             referral_received_at: `${dayKeys[5]}T15:00:00Z` },
    { admission_urgency: null,             referral_received_at: `${dayKeys[5]}T16:00:00Z` },
    { admission_urgency: null,             referral_received_at: `${dayKeys[5]}T17:00:00Z` },
    // dayKeys[6] intentionally empty
  ];

  const byUrgency = aggregateUrgencyCounts(rows);
  const perDayByUrgency = aggregateUrgencyPerDay(rows, dayKeys);

  it("bar chart X-axis labels match the counts list labels exactly", () => {
    const axisLabels = byUrgency.map((b) => b.urgency); // <XAxis dataKey="urgency">
    const countsLabels = byUrgency.map((b) => b.urgency); // <li>{u.urgency}</li>
    expect(axisLabels).toEqual(countsLabels);
  });

  it("bar chart / counts labels are a subset of the canonical display order, in order", () => {
    const axisLabels = byUrgency.map((b) => b.urgency);
    const filteredOrder = URGENCY_DISPLAY_ORDER.filter((l) => axisLabels.includes(l));
    expect(axisLabels).toEqual(filteredOrder);
    for (const label of axisLabels) {
      expect(URGENCY_DISPLAY_ORDER).toContain(label);
    }
  });

  it("stacked-area legend keys equal the canonical display order", () => {
    expect(URGENCY_LEGEND_KEYS).toEqual(URGENCY_DISPLAY_ORDER);
  });

  it("every stacked-area data row exposes exactly the legend keys (zero-filled)", () => {
    expect(perDayByUrgency.length).toBe(dayKeys.length);
    for (const row of perDayByUrgency) {
      const dataKeys = Object.keys(row).filter((k) => k !== "date");
      expect(dataKeys.sort()).toEqual([...URGENCY_LEGEND_KEYS].sort());
      for (const k of URGENCY_LEGEND_KEYS) {
        expect(typeof row[k]).toBe("number");
      }
    }
  });

  it("column totals in the stacked area equal the bar chart counts for the same label", () => {
    const stackTotals: Record<string, number> = {};
    for (const k of URGENCY_LEGEND_KEYS) stackTotals[k] = 0;
    for (const row of perDayByUrgency) {
      for (const k of URGENCY_LEGEND_KEYS) {
        stackTotals[k] += (row[k] as number) ?? 0;
      }
    }
    for (const { urgency, count } of byUrgency) {
      expect(stackTotals[urgency]).toBe(count);
    }
    // And labels not present in byUrgency are zero across the stack.
    const present = new Set(byUrgency.map((b) => b.urgency));
    for (const k of URGENCY_LEGEND_KEYS) {
      if (!present.has(k)) expect(stackTotals[k]).toBe(0);
    }
  });

  it("totals across all surfaces equal the row count", () => {
    const countsTotal = byUrgency.reduce((a, b) => a + b.count, 0);
    const stackTotal = perDayByUrgency.reduce((sum, row) => {
      return (
        sum +
        URGENCY_LEGEND_KEYS.reduce((s, k) => s + ((row[k] as number) ?? 0), 0)
      );
    }, 0);
    expect(countsTotal).toBe(rows.length);
    expect(stackTotal).toBe(rows.length);
  });

  it('routes null urgency to the canonical "Not set" label across both surfaces', () => {
    const notSetCount = byUrgency.find((b) => b.urgency === URGENCY_NOT_SET_LABEL)?.count;
    expect(notSetCount).toBe(3);
    const stackNotSet = perDayByUrgency.reduce(
      (s, row) => s + ((row[URGENCY_NOT_SET_LABEL] as number) ?? 0),
      0
    );
    expect(stackNotSet).toBe(3);
  });

  it("empty days still produce a stacked-area bucket with all-zero legend keys", () => {
    const emptyDayDisplay = format(new Date(dayKeys[6]), "dd MMM");
    const row = perDayByUrgency.find((r) => r.date === emptyDayDisplay);
    expect(row).toBeDefined();
    for (const k of URGENCY_LEGEND_KEYS) {
      expect(row![k]).toBe(0);
    }
  });
});

/**
 * Integration test for the analytics page date-range filter.
 *
 * Simulates the user changing the date-range Popover/quick-preset on the
 * analytics page by recomputing `filtered`, `dayKeys`, `byUrgency`, and
 * `perDayByUrgency` exactly the way <AnalyticsPage> does. Asserts that the
 * urgency legend, bar-chart axis labels, and counts list update together
 * and stay aligned for each selected period.
 */
describe("analytics date-range filter updates urgency surfaces together", () => {
  const now = new Date("2026-06-25T12:00:00Z");

  // A 90-day pool spanning many urgencies, including a cluster of
  // "within_15_min" only in the most recent 7 days and a "not_admitting"
  // cluster only 60+ days ago. Lets us prove range changes shift which
  // labels appear in axis/counts/legend together.
  const pool: UrgencyRow[] = [
    // Last 7 days — only within_15_min + nulls
    ...Array.from({ length: 4 }, (_, i) => ({
      admission_urgency: "within_15_min" as const,
      referral_received_at: new Date(now.getTime() - i * 86_400_000).toISOString(),
    })),
    { admission_urgency: null, referral_received_at: new Date(now.getTime() - 2 * 86_400_000).toISOString() },

    // 20-40 days ago — within_30_min + within_1_hour
    { admission_urgency: "within_30_min", referral_received_at: new Date(now.getTime() - 15 * 86_400_000).toISOString() },
    { admission_urgency: "within_30_min", referral_received_at: new Date(now.getTime() - 20 * 86_400_000).toISOString() },
    { admission_urgency: "within_1_hour", referral_received_at: new Date(now.getTime() - 25 * 86_400_000).toISOString() },

    // 60-80 days ago — not_admitting + within_1_2_hours
    { admission_urgency: "not_admitting", referral_received_at: new Date(now.getTime() - 65 * 86_400_000).toISOString() },
    { admission_urgency: "not_admitting", referral_received_at: new Date(now.getTime() - 70 * 86_400_000).toISOString() },
    { admission_urgency: "within_1_2_hours", referral_received_at: new Date(now.getTime() - 75 * 86_400_000).toISOString() },
  ];

  /** Mirrors the page's pipeline for a chosen quick-preset (in days). */
  function selectRange(days: number) {
    const to = endOfDay(now);
    const from = startOfDay(subDays(to, days - 1));
    const filtered = pool.filter((r) => {
      const t = new Date(r.referral_received_at).getTime();
      return t >= from.getTime() && t <= to.getTime();
    });
    const dayKeys = eachDayOfInterval({ start: from, end: to }).map((d) =>
      format(d, "yyyy-MM-dd")
    );
    return {
      from,
      to,
      filtered,
      dayKeys,
      byUrgency: aggregateUrgencyCounts(filtered),
      perDayByUrgency: aggregateUrgencyPerDay(filtered, dayKeys),
    };
  }

  function legendKeysWithData(perDay: ReturnType<typeof selectRange>["perDayByUrgency"]) {
    const totals: Record<string, number> = {};
    for (const k of URGENCY_LEGEND_KEYS) totals[k] = 0;
    for (const row of perDay) {
      for (const k of URGENCY_LEGEND_KEYS) totals[k] += (row[k] as number) ?? 0;
    }
    // Mirror display order, only labels with non-zero stack totals.
    return URGENCY_LEGEND_KEYS.filter((k) => totals[k] > 0);
  }

  it("7-day range only surfaces labels present in the last week", () => {
    const r = selectRange(7);
    const expected = ["Within 15 minutes", URGENCY_NOT_SET_LABEL];
    const axis = r.byUrgency.map((b) => b.urgency);
    const counts = r.byUrgency.map((b) => b.urgency);
    const legend = legendKeysWithData(r.perDayByUrgency);

    expect(axis).toEqual(expected);
    expect(counts).toEqual(expected);
    expect(legend).toEqual(expected);
    expect(r.perDayByUrgency.length).toBe(7);
  });

  it("30-day range expands to include 30-min / 1-hour clusters across all surfaces", () => {
    const r = selectRange(30);
    const axis = r.byUrgency.map((b) => b.urgency);
    const legend = legendKeysWithData(r.perDayByUrgency);

    expect(axis).toEqual(legend);
    expect(axis).toContain("Within 15 minutes");
    expect(axis).toContain("Within 30 minutes");
    expect(axis).toContain("Within 1 hour");
    expect(axis).not.toContain("N/A (decision not to admit)");
    expect(axis).not.toContain("Within 1–2 hours");
    expect(r.perDayByUrgency.length).toBe(30);
  });

  it("90-day range adds the older not_admitting / 1–2h clusters to every surface", () => {
    const r = selectRange(90);
    const axis = r.byUrgency.map((b) => b.urgency);
    const legend = legendKeysWithData(r.perDayByUrgency);

    expect(axis).toEqual(legend);
    for (const label of [
      "Within 15 minutes",
      "Within 30 minutes",
      "Within 1 hour",
      "Within 1–2 hours",
      "N/A (decision not to admit)",
      URGENCY_NOT_SET_LABEL,
    ]) {
      expect(axis).toContain(label);
    }
    expect(r.perDayByUrgency.length).toBe(90);
  });

  it("shrinking the range removes labels from axis, counts, AND legend together", () => {
    const wide = selectRange(90);
    const narrow = selectRange(7);

    const wideLabels = new Set(wide.byUrgency.map((b) => b.urgency));
    const narrowLabels = new Set(narrow.byUrgency.map((b) => b.urgency));
    const dropped = [...wideLabels].filter((l) => !narrowLabels.has(l));

    expect(dropped.length).toBeGreaterThan(0);
    for (const label of dropped) {
      // Bar/counts axis dropped it.
      expect(narrow.byUrgency.find((b) => b.urgency === label)).toBeUndefined();
      // Stacked area legend dropped it (no data in any bucket).
      const stackTotal = narrow.perDayByUrgency.reduce(
        (s, row) => s + ((row[label] as number) ?? 0),
        0
      );
      expect(stackTotal).toBe(0);
    }
  });

  it("counts and stacked-area totals stay equal to filtered row count for every range", () => {
    for (const days of [7, 30, 90]) {
      const r = selectRange(days);
      const countsTotal = r.byUrgency.reduce((a, b) => a + b.count, 0);
      const stackTotal = r.perDayByUrgency.reduce(
        (sum, row) =>
          sum + URGENCY_LEGEND_KEYS.reduce((s, k) => s + ((row[k] as number) ?? 0), 0),
        0
      );
      expect(countsTotal).toBe(r.filtered.length);
      expect(stackTotal).toBe(r.filtered.length);
    }
  });
});

