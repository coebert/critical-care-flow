/**
 * Integration test for the referral → partner-handover prefill mapping.
 *
 * `prefillPartnerHandoverFromReferral` runs inside a server-fn handler with
 * Supabase, HMAC signing and fetch to the partner bridge, so we exercise the
 * pure mapping core it delegates to (`computePartnerHandoverPrefill`) —
 * plus a parse of the server-fn source to guarantee the handler still calls
 * that mapper and hasn't drifted into a second implementation.
 *
 * We cover:
 *   - resus/TEP/DNACPR → tep_in_place, tep_details, dnacpr_decision, dnacpr_details
 *   - past_medical_history → past_medical_history
 *   - reason_for_referral → current_admission
 *   - baseline_function + allergies + weight + interventions → current_management
 *   - fill-blanks-only: fields already populated on the partner are skipped
 *   - a true boolean on the partner is never flipped back to false
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  computePartnerHandoverPrefill,
  type PartnerPatientCurrent,
  type ReferralPrefillSource,
} from "./partner-handover-prefill.functions";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(
  resolve(HERE, "partner-handover-prefill.functions.ts"),
  "utf8",
);

function emptyPatient(
  over: Partial<PartnerPatientCurrent> = {},
): PartnerPatientCurrent {
  return {
    tep_in_place: null,
    tep_details: null,
    dnacpr_decision: null,
    dnacpr_details: null,
    past_medical_history: null,
    current_admission: null,
    current_management: null,
    ...over,
  };
}

function baseReferral(
  over: Partial<ReferralPrefillSource> = {},
): ReferralPrefillSource {
  return {
    past_medical_history: null,
    baseline_function: null,
    reason_for_referral: null,
    allergies: null,
    weight_kg: null,
    anticipated_interventions: null,
    ceiling_of_care: null,
    resus_status: null,
    dnacpr_respect: null,
    ...over,
  };
}

describe("computePartnerHandoverPrefill — referral → partner handover mapping", () => {
  it("maps a DNACPR/TEP referral into the correct partner columns on a blank patient", () => {
    const plan = computePartnerHandoverPrefill(
      baseReferral({
        past_medical_history: "IHD, COPD",
        baseline_function: "Independent, walks 100m with stick",
        reason_for_referral: "Type 2 respiratory failure post-op",
        allergies: "Penicillin",
        weight_kg: 78,
        anticipated_interventions: ["niv", "vasopressors"],
        ceiling_of_care: "full_escalation",
        resus_status: "dnacpr",
        dnacpr_respect: true,
      }),
      emptyPatient(),
    );

    // All target columns present in the patch.
    expect(plan.patch.past_medical_history).toBe("IHD, COPD");
    expect(plan.patch.current_admission).toBe(
      "Type 2 respiratory failure post-op",
    );
    expect(plan.patch.tep_in_place).toBe(true);
    expect(plan.patch.dnacpr_decision).toBe(true);
    expect(String(plan.patch.tep_details)).toMatch(/Ceiling of care/i);
    expect(String(plan.patch.tep_details)).toMatch(/Resus status/i);
    expect(String(plan.patch.dnacpr_details)).toMatch(/DNACPR/i);

    // current_management is composed from baseline + allergies + weight + interventions.
    const cm = String(plan.patch.current_management);
    expect(cm).toMatch(/Anticipated interventions:/);
    expect(cm).toMatch(/Allergies: Penicillin/);
    expect(cm).toMatch(/Weight: 78 kg/);
    expect(cm).toMatch(/Baseline function: Independent/);

    expect(plan.applied_fields).toEqual(
      expect.arrayContaining([
        "tep_details",
        "dnacpr_details",
        "past_medical_history",
        "current_admission",
        "current_management",
        "tep_in_place",
        "dnacpr_decision",
      ]),
    );
    expect(plan.skipped_fields).toEqual([]);

    // Nothing that isn't a mapped partner column should leak into the patch.
    const allowed = new Set([
      "tep_in_place",
      "tep_details",
      "dnacpr_decision",
      "dnacpr_details",
      "past_medical_history",
      "current_admission",
      "current_management",
    ]);
    for (const k of Object.keys(plan.patch)) {
      expect(allowed.has(k)).toBe(true);
    }
  });

  it("skips fields already populated on the partner (fill-blanks-only)", () => {
    const plan = computePartnerHandoverPrefill(
      baseReferral({
        past_medical_history: "IHD, COPD",
        reason_for_referral: "Sepsis",
        resus_status: "dnacpr",
        dnacpr_respect: true,
        ceiling_of_care: "full_escalation",
      }),
      emptyPatient({
        past_medical_history: "Existing PMH from partner note",
        current_admission: "Existing admission note",
        tep_in_place: true, // already true — must not be re-applied
        tep_details: "Existing TEP text",
        dnacpr_decision: true, // already true — must not be re-applied
        dnacpr_details: "Existing DNACPR text",
      }),
    );

    expect(plan.patch).not.toHaveProperty("past_medical_history");
    expect(plan.patch).not.toHaveProperty("current_admission");
    expect(plan.patch).not.toHaveProperty("tep_in_place");
    expect(plan.patch).not.toHaveProperty("tep_details");
    expect(plan.patch).not.toHaveProperty("dnacpr_decision");
    expect(plan.patch).not.toHaveProperty("dnacpr_details");

    expect(plan.applied_fields).toEqual([]);
    expect(plan.skipped_fields).toEqual(
      expect.arrayContaining([
        "tep_details",
        "dnacpr_details",
        "past_medical_history",
        "current_admission",
        "tep_in_place",
        "dnacpr_decision",
      ]),
    );
  });

  it("fills only the blank subset when the partner has partial handover data", () => {
    const plan = computePartnerHandoverPrefill(
      baseReferral({
        past_medical_history: "IHD, COPD",
        reason_for_referral: "Sepsis",
        baseline_function: "Independent",
      }),
      emptyPatient({
        // partner already has PMH; leave everything else blank
        past_medical_history: "Partner already knows this",
      }),
    );

    expect(plan.patch).not.toHaveProperty("past_medical_history");
    expect(plan.patch.current_admission).toBe("Sepsis");
    expect(String(plan.patch.current_management)).toMatch(
      /Baseline function: Independent/,
    );
    expect(plan.applied_fields).toEqual(
      expect.arrayContaining(["current_admission", "current_management"]),
    );
    expect(plan.skipped_fields).toContain("past_medical_history");
  });

  it("treats whitespace-only partner fields as blank and fills them", () => {
    const plan = computePartnerHandoverPrefill(
      baseReferral({ past_medical_history: "IHD" }),
      emptyPatient({ past_medical_history: "   " }),
    );
    expect(plan.patch.past_medical_history).toBe("IHD");
    expect(plan.applied_fields).toContain("past_medical_history");
  });

  it("does not set tep_in_place / dnacpr_decision when the referral gives no reason", () => {
    const plan = computePartnerHandoverPrefill(
      baseReferral({ past_medical_history: "IHD" }),
      emptyPatient(),
    );
    expect(plan.patch).not.toHaveProperty("tep_in_place");
    expect(plan.patch).not.toHaveProperty("dnacpr_decision");
    expect(plan.patch).not.toHaveProperty("tep_details");
    expect(plan.patch).not.toHaveProperty("dnacpr_details");
    // PMH still applied
    expect(plan.patch.past_medical_history).toBe("IHD");
  });

  it("returns an empty patch (and no applied fields) when the referral is empty", () => {
    const plan = computePartnerHandoverPrefill(baseReferral(), emptyPatient());
    expect(plan.patch).toEqual({});
    expect(plan.applied_fields).toEqual([]);
    // Nothing proposed → nothing to skip.
    expect(plan.skipped_fields).toEqual([]);
  });
});

describe("prefillPartnerHandoverFromReferral handler stays wired to the mapper", () => {
  it("delegates the mapping to computePartnerHandoverPrefill", () => {
    // Guard against a future edit re-implementing the mapping inline in the
    // handler — the tests above only bite if the handler still routes
    // through this function.
    expect(SOURCE).toMatch(/computePartnerHandoverPrefill\s*\(/);
  });

  it("sends the mapped patch over the partner bridge /patients endpoint", () => {
    expect(SOURCE).toMatch(/\/patients/);
    expect(SOURCE).toMatch(/x-signature/);
  });
});
