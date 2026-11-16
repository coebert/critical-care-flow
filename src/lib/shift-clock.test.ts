import { describe, it, expect } from "vitest";
import { currentShift, nextShift, formatUnitTime } from "./shift-clock";

const at = (iso: string) => currentShift(new Date(iso));

describe("Europe/London shift clock", () => {
  it("winter (GMT): day 08:00–19:59, night from 20:00", () => {
    expect(at("2026-01-15T07:59:00Z")).toEqual({ date: "2026-01-14", shift: "night" });
    expect(at("2026-01-15T08:00:00Z")).toEqual({ date: "2026-01-15", shift: "day" });
    expect(at("2026-01-15T19:59:00Z")).toEqual({ date: "2026-01-15", shift: "day" });
    expect(at("2026-01-15T20:00:00Z")).toEqual({ date: "2026-01-15", shift: "night" });
  });

  it("summer (BST): boundaries are London local, not UTC", () => {
    // 07:30 UTC = 08:30 BST → day
    expect(at("2026-07-10T07:30:00Z")).toEqual({ date: "2026-07-10", shift: "day" });
    // 06:59 UTC = 07:59 BST → previous night
    expect(at("2026-07-10T06:59:00Z")).toEqual({ date: "2026-07-09", shift: "night" });
    // 19:00 UTC = 20:00 BST → night
    expect(at("2026-07-10T19:00:00Z")).toEqual({ date: "2026-07-10", shift: "night" });
  });

  it("after midnight belongs to the previous calendar date's night", () => {
    // 23:30 UTC on 9 July = 00:30 BST on 10 July
    expect(at("2026-07-09T23:30:00Z")).toEqual({ date: "2026-07-09", shift: "night" });
    expect(at("2026-01-15T00:30:00Z")).toEqual({ date: "2026-01-14", shift: "night" });
    expect(at("2027-01-01T03:00:00Z")).toEqual({ date: "2026-12-31", shift: "night" });
  });

  it("DST change nights (29 Mar and 25 Oct 2026)", () => {
    // Spring forward: 01:00 GMT -> 02:00 BST. 07:30 UTC = 08:30 BST → day
    expect(at("2026-03-29T07:30:00Z")).toEqual({ date: "2026-03-29", shift: "day" });
    expect(at("2026-03-29T06:30:00Z")).toEqual({ date: "2026-03-28", shift: "night" });
    // Fall back: 02:00 BST -> 01:00 GMT. 07:30 UTC = 07:30 GMT → still night
    expect(at("2026-10-25T07:30:00Z")).toEqual({ date: "2026-10-24", shift: "night" });
    expect(at("2026-10-25T08:00:00Z")).toEqual({ date: "2026-10-25", shift: "day" });
    // Repeated 01:xx hour both map to the same night
    expect(at("2026-10-25T00:30:00Z")).toEqual({ date: "2026-10-24", shift: "night" });
    expect(at("2026-10-25T01:30:00Z")).toEqual({ date: "2026-10-24", shift: "night" });
  });

  it("next shift crosses into the next calendar date after a night", () => {
    expect(nextShift({ date: "2026-12-31", shift: "night" })).toEqual({ date: "2027-01-01", shift: "day" });
    expect(nextShift({ date: "2026-03-28", shift: "day" })).toEqual({ date: "2026-03-28", shift: "night" });
  });

  it("formats unit times in London time and dates other days", () => {
    const now = new Date("2026-07-10T09:00:00Z");
    expect(formatUnitTime("2026-07-10T08:15:00Z", now)).toBe("09:15");
    expect(formatUnitTime("2026-07-09T22:00:00Z", now)).toBe("09/07 23:00");
    expect(formatUnitTime(null, now)).toBe("—");
  });
});
