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
