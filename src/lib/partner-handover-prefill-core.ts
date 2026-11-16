/**
 * Referral → ICU Handover Hub handover prefill: pure mapping (client-safe).
 *
 * Clinical safety rules:
 *  - Fill-blanks only: a Hub field that already has content is never touched.
 *  - TEP and DNACPR decisions are NEVER written. Explicit false values are
 *    preserved; a DNACPR decision is not inferred from a ReSPECT/DNACPR form
 *    flag, and a completed TEP is not inferred from interventions, ceiling
 *    of care or an undocumented status.
 *  - Everything copied is labelled as referral source text for clinician
 *    review, not a decision.
 */
import {
  ANTICIPATED_INTERVENTIONS,
  CEILING_OF_CARE_OPTIONS,
  RESUS_STATUS_OPTIONS,
} from "./referral-clinical";

export const SOURCE_LABEL = "[From critical care referral — referral source text for clinician review, not a decision]";

export interface ReferralPrefillSource {
  past_medical_history: string | null;
  baseline_function: string | null;
  reason_for_referral: string | null;
  allergies: string | null;
  weight_kg: number | null;
  anticipated_interventions: string[] | null;
  ceiling_of_care: string | null;
  resus_status: string | null;
  dnacpr_respect: boolean | null;
}

/** The Hub fields the prefill may fill (TEP/DNACPR deliberately absent). */
export const PREFILL_FIELDS = ["past_medical_history", "current_admission", "current_management"] as const;
export type PrefillField = (typeof PREFILL_FIELDS)[number];

export const PREFILL_FIELD_LABEL: Record<PrefillField, string> = {
  past_medical_history: "Past medical history",
  current_admission: "Current admission (reason for referral)",
  current_management: "Current management (referral details)",
};

export type PartnerPatientCurrent = Partial<Record<PrefillField, unknown>> & Record<string, unknown>;

export interface PartnerHandoverPrefillPlan {
  patch: Partial<Record<PrefillField, string>>;
  applied_fields: PrefillField[];
  skipped_fields: PrefillField[];
}

const label = (opts: ReadonlyArray<{ value: string; label: string }>, v: string | null | undefined) =>
  v ? (opts.find((o) => o.value === v)?.label ?? v) : null;

export function isBlank(v: unknown): boolean {
  return v == null || (typeof v === "string" && v.trim() === "");
}

const clean = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

export function composeCurrentManagement(ref: ReferralPrefillSource): string | null {
  const parts: string[] = [];
  if (ref.anticipated_interventions?.length) {
    parts.push(
      `Anticipated interventions (referral): ${ref.anticipated_interventions
        .map((v) => label(ANTICIPATED_INTERVENTIONS, v) ?? v)
        .join(", ")}.`,
    );
  }
  if (clean(ref.allergies)) parts.push(`Allergies (referral): ${clean(ref.allergies)}.`);
  if (ref.weight_kg != null && Number.isFinite(ref.weight_kg)) parts.push(`Weight (referral): ${ref.weight_kg} kg.`);
  if (clean(ref.baseline_function)) parts.push(`Baseline function (referral): ${clean(ref.baseline_function)}.`);
  const ceiling = label(CEILING_OF_CARE_OPTIONS, ref.ceiling_of_care);
  if (ceiling) parts.push(`Ceiling of care as written on referral: ${ceiling}.`);
  const resus = label(RESUS_STATUS_OPTIONS, ref.resus_status);
  if (resus) parts.push(`Resuscitation status as written on referral: ${resus}.`);
  if (ref.dnacpr_respect === true) parts.push("Referral notes a ReSPECT / DNACPR form is present (form presence only).");
  if (ceiling || resus || ref.dnacpr_respect === true) {
    parts.push("TEP / DNACPR decisions are not copied — confirm and record them in ICU Handover Hub.");
  }
  return parts.length ? parts.join("\n") : null;
}

const labelled = (v: string | null) => (v ? `${SOURCE_LABEL}\n${v}` : null);

export function computePartnerHandoverPrefill(
  ref: ReferralPrefillSource,
  patient: PartnerPatientCurrent,
): PartnerHandoverPrefillPlan {
  const proposed: Record<PrefillField, string | null> = {
    past_medical_history: labelled(clean(ref.past_medical_history)),
    current_admission: labelled(clean(ref.reason_for_referral)),
    current_management: labelled(composeCurrentManagement(ref)),
  };
  const patch: Partial<Record<PrefillField, string>> = {};
  const applied: PrefillField[] = [];
  const skipped: PrefillField[] = [];
  for (const k of PREFILL_FIELDS) {
    const v = proposed[k];
    if (!v) continue;
    if (isBlank(patient[k])) {
      patch[k] = v;
      applied.push(k);
    } else {
      skipped.push(k);
    }
  }
  return { patch, applied_fields: applied, skipped_fields: skipped };
}

export type PrefillFailureCode =
  | "forbidden"
  | "not_configured"
  | "referral_not_found"
  | "not_shared"
  | "link_unverified"
  | "link_mismatch"
  | "decrypt_failed"
  | "partner_unavailable"
  | "invalid_preview"
  | "stale_preview"
  | "conflict"
  | "rejected";

export type PrefillPreviewResult =
  | {
      ok: true;
      token: string;
      fields: Array<{ field: PrefillField; label: string; value: string }>;
      skipped_fields: PrefillField[];
      link_basis: "source_referral" | "hospital_number";
      expires_at: string;
    }
  | { ok: false; code: PrefillFailureCode; message: string };

export type PrefillApplyResult =
  | { ok: true; applied_fields: PrefillField[]; updated_at: string | null }
  | { ok: false; code: PrefillFailureCode; message: string };

export const PREFILL_MESSAGES: Record<PrefillFailureCode, string> = {
  forbidden: "Your account does not have clinical access.",
  not_configured: "The ICU Handover Hub link is not configured.",
  referral_not_found: "The referral could not be found.",
  not_shared: "This patient is not (or no longer) shared by ICU Handover Hub.",
  link_unverified:
    "This bed's patient can't be confirmed as the referred patient. Make sure the hospital number in ICU Handover Hub exactly matches the referral (or admit from the referral's own link), then try again.",
  link_mismatch:
    "The patient in this bed does not match the referral. Nothing was copied. Check you opened the right bed and referral.",
  decrypt_failed: "Referral details could not be read securely. Nothing was copied.",
  partner_unavailable: "ICU Handover Hub could not be reached. Nothing was copied — try again shortly.",
  invalid_preview: "This preview is no longer valid. Reload the preview and confirm again.",
  stale_preview: "The referral or the Hub patient changed after the preview. Reload the preview and confirm again.",
  conflict: "The Hub patient was changed by someone else just now. Nothing was copied — reload the preview and confirm again.",
  rejected: "ICU Handover Hub rejected the update. Nothing was copied.",
};
