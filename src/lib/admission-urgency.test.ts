import { describe, it, expect } from "vitest";
import {
  ADMISSION_URGENCY_OPTIONS,
  ADMISSION_URGENCY_LABELS,
  URGENCY_DISPLAY_ORDER,
  URGENCY_NOT_SET_LABEL,
  urgencyLabel,
  type AdmissionUrgency,
} from "./admission-urgency";

describe("urgency labels", () => {
  it("resolves every enum value to its option label", () => {
    for (const opt of ADMISSION_URGENCY_OPTIONS) {
      expect(urgencyLabel(opt.value)).toBe(opt.label);
      expect(ADMISSION_URGENCY_LABELS[opt.value]).toBe(opt.label);
    }
  });

  it('resolves null/undefined to "Not set"', () => {
    expect(urgencyLabel(null)).toBe("Not set");
    expect(urgencyLabel(undefined)).toBe("Not set");
    expect(URGENCY_NOT_SET_LABEL).toBe("Not set");
  });

  it('uses the canonical "N/A (decision not to admit)" label for not_admitting', () => {
    expect(urgencyLabel("not_admitting")).toBe("N/A (decision not to admit)");
  });

  it("display order contains every enum label plus Not set, in that order", () => {
    expect(URGENCY_DISPLAY_ORDER).toEqual([
      ...ADMISSION_URGENCY_OPTIONS.map((o) => o.label),
      URGENCY_NOT_SET_LABEL,
    ]);
    expect(URGENCY_DISPLAY_ORDER[URGENCY_DISPLAY_ORDER.length - 1]).toBe(URGENCY_NOT_SET_LABEL);
  });

  it("display order is unique (no duplicate categories across counts/legend/axis)", () => {
    expect(new Set(URGENCY_DISPLAY_ORDER).size).toBe(URGENCY_DISPLAY_ORDER.length);
  });
});

describe("analytics aggregation parity", () => {
  type Row = { admission_urgency: AdmissionUrgency | null };

  // Mirror of byUrgency / perDayByUrgency reducers in analytics.tsx
  function aggregateCounts(rows: Row[]) {
    const map = new Map<string, number>();
    rows.forEach((r) => {
      const k = urgencyLabel(r.admission_urgency);
      map.set(k, (map.get(k) ?? 0) + 1);
    });
    return URGENCY_DISPLAY_ORDER
      .filter((label) => map.has(label))
      .map((label) => ({ urgency: label, count: map.get(label)! }));
  }

  function aggregateStack(rows: Row[]) {
    const row: Record<string, number> = {};
    URGENCY_DISPLAY_ORDER.forEach((u) => (row[u] = 0));
    rows.forEach((r) => {
      const label = urgencyLabel(r.admission_urgency);
      row[label] = (row[label] ?? 0) + 1;
    });
    return row;
  }

  const sample: Row[] = [
    { admission_urgency: "within_15_min" },
    { admission_urgency: "within_15_min" },
    { admission_urgency: "not_admitting" },
    { admission_urgency: null },
    { admission_urgency: null },
    { admission_urgency: null },
  ];

  it("count totals match stacked totals for every label", () => {
    const counts = aggregateCounts(sample);
    const stack = aggregateStack(sample);
    for (const { urgency, count } of counts) {
      expect(stack[urgency]).toBe(count);
    }
  });

  it("every key produced by the aggregators is in the legend display order", () => {
    const counts = aggregateCounts(sample);
    const stack = aggregateStack(sample);
    for (const { urgency } of counts) {
      expect(URGENCY_DISPLAY_ORDER).toContain(urgency);
    }
    for (const key of Object.keys(stack)) {
      expect(URGENCY_DISPLAY_ORDER).toContain(key);
    }
  });

  it("N/A and Not set rows are bucketed under their canonical labels (not raw enum / null)", () => {
    const stack = aggregateStack(sample);
    expect(stack["N/A (decision not to admit)"]).toBe(1);
    expect(stack["Not set"]).toBe(3);
    expect(stack["not_admitting"]).toBeUndefined();
    expect(stack["null"]).toBeUndefined();
  });
});
