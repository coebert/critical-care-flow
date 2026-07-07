import { describe, it, expect } from "vitest";
import { aggregateNurseCapacitySeries, eachDate } from "./nurse-capacity-analytics";

describe("eachDate", () => {
  it("enumerates inclusive date range", () => {
    expect(eachDate("2026-07-01", "2026-07-03")).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
    ]);
  });
  it("returns [] for inverted range", () => {
    expect(eachDate("2026-07-03", "2026-07-01")).toEqual([]);
  });
});

describe("aggregateNurseCapacitySeries", () => {
  it("computes dependency from live stays and joins staffing", () => {
    const series = aggregateNurseCapacitySeries({
      from: "2026-07-01",
      to: "2026-07-02",
      stays: [
        // Present on both days
        { admitted_at: "2026-06-30T08:00:00", discharged_at: null, level: 3 },
        // Discharged on 2026-07-01 morning — gone by both sample times
        { admitted_at: "2026-06-29T08:00:00", discharged_at: "2026-07-01T09:00:00", level: 2 },
      ],
      staffing: [
        { shift_date: "2026-07-01", shift: "day", available_nurses: 8 },
        { shift_date: "2026-07-01", shift: "night", available_nurses: 6 },
      ],
    });
    expect(series).toHaveLength(2);
    expect(series[0].dependency_day).toBe(1);
    expect(series[0].nurses_day).toBe(8);
    expect(series[0].spare_day).toBe(7);
    expect(series[0].nurses_night).toBe(6);
    expect(series[0].spare_night).toBe(5);
    expect(series[1].nurses_day).toBeNull();
    expect(series[1].spare_day).toBeNull();
    expect(series[1].dependency_day).toBe(1);
  });
});
