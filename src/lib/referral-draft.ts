import type { AdmissionUrgency } from "@/lib/admission-urgency";

export function localISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export const DRAFT_KEY = "referral-draft-v1";
// Bump this when the shape of what's persisted changes so old drafts (which
// may have contained PHI written by an earlier version) are ignored / cleared.
export const DRAFT_SAFE_VERSION = 2;

export type DraftForm = {
  age: string;
  sex: "male" | "female" | "other" | "unknown";
  hospital_number: string;
  patient_initials: string;
  current_ward: string;
  current_bed: string;
  past_medical_history: string;
  baseline_function: string;
  dnacpr_respect: boolean;
  consultant_to_consultant_only: boolean;
  referring_specialty: string;
  reason_for_referral: string;
  referral_received_at: string;
  first_seen_at: string;
  decision_at: string;
  arrived_on_unit_at: string;
  status: "pending" | "accepted" | "declined" | "admitted";
  decline_reason: string;
  discussed_with_consultant: string;
  accepting_consultant: string;
  admission_urgency: AdmissionUrgency | "";
  is_test: boolean;
};

// PHI / patient-identifying free-text fields are NEVER persisted to
// localStorage. The database encrypts these at rest, but browser storage is
// plaintext and readable by anyone with access to the workstation (common on
// shared NHS terminals). Only non-identifying workflow scaffolding
// (timestamps, status, ward/bed labels, urgency, flags) is auto-saved so a
// user doesn't lose their place after an accidental reload.
export const SENSITIVE_DRAFT_KEYS = [
  "hospital_number",
  "past_medical_history",
  "baseline_function",
  "reason_for_referral",
  "decline_reason",
  "discussed_with_consultant",
  "accepting_consultant",
  "age",
  "sex",
] as const satisfies ReadonlyArray<keyof DraftForm>;

export type SafeDraft = Partial<Omit<DraftForm, (typeof SENSITIVE_DRAFT_KEYS)[number]>> & {
  __v?: number;
};

export function toSafeDraft(d: DraftForm): SafeDraft {
  const copy: Partial<DraftForm> = { ...d };
  for (const k of SENSITIVE_DRAFT_KEYS) delete copy[k];
  return { ...(copy as SafeDraft), __v: DRAFT_SAFE_VERSION };
}

export const blankForm = (): DraftForm => ({
  age: "",
  sex: "unknown",
  hospital_number: "",
  patient_initials: "",
  current_ward: "",
  current_bed: "",
  past_medical_history: "",
  baseline_function: "",
  dnacpr_respect: false,
  consultant_to_consultant_only: false,
  referring_specialty: "",
  reason_for_referral: "",
  referral_received_at: localISO(),
  first_seen_at: "",
  decision_at: "",
  arrived_on_unit_at: "",
  status: "pending",
  decline_reason: "",
  discussed_with_consultant: "",
  accepting_consultant: "",
  admission_urgency: "",
  is_test: false,
});

export function isSafeDraftDirty(d: DraftForm): boolean {
  const b = blankForm();
  const safeKeys = (Object.keys(b) as (keyof DraftForm)[]).filter(
    (k) =>
      k !== "referral_received_at" &&
      !(SENSITIVE_DRAFT_KEYS as readonly string[]).includes(k),
  );
  return safeKeys.some((k) => d[k] !== b[k]);
}
