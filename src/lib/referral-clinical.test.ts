import { describe, it, expect } from "vitest";
import { computeNews2Tone, shouldShowFrailty } from "./referral-clinical";

describe("computeNews2Tone", () => {
  it("returns none for null/undefined", () => {
    expect(computeNews2Tone(null)).toBe("none");
    expect(computeNews2Tone(undefined)).toBe("none");
  });
  it("green for 0-4", () => {
    for (const s of [0, 1, 2, 3, 4]) expect(computeNews2Tone(s)).toBe("green");
  });
  it("amber for 5-6", () => {
    expect(computeNews2Tone(5)).toBe("amber");
    expect(computeNews2Tone(6)).toBe("amber");
  });
  it("red for >=7", () => {
    expect(computeNews2Tone(7)).toBe("red");
    expect(computeNews2Tone(14)).toBe("red");
  });
});

describe("shouldShowFrailty", () => {
  it("hidden under 65 or missing", () => {
    expect(shouldShowFrailty(null)).toBe(false);
    expect(shouldShowFrailty(undefined)).toBe(false);
    expect(shouldShowFrailty(64)).toBe(false);
  });
  it("shown at 65 and above", () => {
    expect(shouldShowFrailty(65)).toBe(true);
    expect(shouldShowFrailty(90)).toBe(true);
  });
});
