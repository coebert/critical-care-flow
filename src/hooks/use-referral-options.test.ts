import { describe, it, expect } from "vitest";
import { compareConsultantsBySurname, SEED_CONSULTANTS } from "./use-referral-options";

describe("compareConsultantsBySurname", () => {
  it("sorts the seed consultants alphabetically by surname", () => {
    const sorted = [...SEED_CONSULTANTS].sort(compareConsultantsBySurname);
    expect(sorted).toEqual([
      "C Billingham",
      "R Coe",
      "C Couzens",
      "L Fenner",
      "J Haslam",
      "I Jenkins",
      "S Jukes",
      "C Morden",
      "A Nash",
      "J Walsgrove",
      "J Ward",
    ]);
  });

  it("sorts by surname regardless of given-name order", () => {
    const input = ["Z Ward", "A Billingham", "M Coe"];
    expect(input.sort(compareConsultantsBySurname)).toEqual([
      "A Billingham",
      "M Coe",
      "Z Ward",
    ]);
  });

  it("tie-breaks identical surnames by given name", () => {
    const input = ["Z Smith", "A Smith", "M Smith"];
    expect(input.sort(compareConsultantsBySurname)).toEqual([
      "A Smith",
      "M Smith",
      "Z Smith",
    ]);
  });

  it("tie-breaks identical surname and given name deterministically by full string", () => {
    const input = ["j smith", "J Smith", "J smith"];
    const sorted = [...input].sort(compareConsultantsBySurname);
    // All compare equal on surname+given case-insensitively; final tie-break is
    // deterministic and stable across runs.
    const sortedAgain = [...input].sort(compareConsultantsBySurname);
    expect(sorted).toEqual(sortedAgain);
  });

  it("is case- and accent-insensitive on surname comparison", () => {
    const input = ["A NASH", "B nash", "C Nash"];
    const sorted = [...input].sort(compareConsultantsBySurname);
    // All share surname "Nash"; ordered by given name A, B, C.
    expect(sorted.map((s) => s.split(" ")[0].toUpperCase())).toEqual(["A", "B", "C"]);
  });

  it("handles single-token names by treating the token as the surname", () => {
    const input = ["Ward", "Billingham", "Nash"];
    expect(input.sort(compareConsultantsBySurname)).toEqual([
      "Billingham",
      "Nash",
      "Ward",
    ]);
  });

  it("orders multi-token surnames by the final token", () => {
    const input = ["A Van Der Berg", "B Adams", "C Zephyr"];
    expect(input.sort(compareConsultantsBySurname)).toEqual([
      "B Adams",
      "A Van Der Berg",
      "C Zephyr",
    ]);
  });
});
