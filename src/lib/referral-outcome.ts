// Referral outcome enum, labels, and validation matrix.
// Pure — no I/O. Safe for both server and client.

export const REFERRAL_OUTCOMES = [
  {
    value: "admit_for_admission",
    label: "Accept for admission",
    description: "Patient is being accepted and admitted to critical care.",
  },
  {
    value: "review_on_ward",
    label: "Review on ward",
    description: "\"Come and review\" — no bed yet, will visit and reassess.",
  },
  {
    value: "advice_given",
    label: "Advice given",
    description: "Telephone advice only. Referral closes with no admission.",
  },
  {
    value: "declined",
    label: "Declined",
    description: "Not accepted for critical care.",
  },
] as const;

export type ReferralOutcome = (typeof REFERRAL_OUTCOMES)[number]["value"];

export function outcomeLabel(v: ReferralOutcome | null | undefined): string | null {
  if (!v) return null;
  return REFERRAL_OUTCOMES.find((o) => o.value === v)?.label ?? v;
}

// Backfill mirror for older rows that only have legacy `status`.
export function deriveOutcomeFromLegacyStatus(
  status: string | null | undefined,
): ReferralOutcome | null {
  switch (status) {
    case "accepted":
    case "admitted":
      return "admit_for_admission";
    case "declined":
      return "declined";
    default:
      return null;
  }
}

export interface OutcomeInputs {
  outcome: ReferralOutcome | null | undefined;
  ceiling_of_care: string | null | undefined;
  reason_notes: string | null | undefined;
  decline_reason: string | null | undefined;
  discussed_with_consultant: string | null | undefined;
  accepting_consultant: string | null | undefined;
  first_seen_at: string | null | undefined;
}

export interface OutcomeValidation {
  isValid: boolean;
  fieldErrors: Record<string, string>;
}

// Required-field matrix per outcome. Deliberately additive on top of the
// existing timing validation in referral-validation.ts.
export function validateReferralOutcome(input: OutcomeInputs): OutcomeValidation {
  const errors: Record<string, string> = {};
  const hasText = (v: string | null | undefined) => !!(v && v.trim());

  // Ceiling of care is required whenever a decision has been recorded.
  if (input.outcome && !hasText(input.ceiling_of_care ?? null)) {
    errors.ceiling_of_care = "Ceiling of care must be recorded before a decision.";
  }

  switch (input.outcome) {
    case "admit_for_admission":
      if (!hasText(input.accepting_consultant)) {
        errors.accepting_consultant = "Required when accepting for admission.";
      }
      break;
    case "review_on_ward":
      if (!input.first_seen_at) {
        errors.first_seen_at = "Record when the patient will be / was seen.";
      }
      break;
    case "advice_given":
      if (!hasText(input.discussed_with_consultant)) {
        errors.discussed_with_consultant = "Required for advice-only outcome.";
      }
      if (!hasText(input.reason_notes)) {
        errors.reason_notes = "Advice given must be documented.";
      }
      break;
    case "declined":
      if (!hasText(input.decline_reason)) {
        errors.decline_reason = "Required when declining a referral.";
      }
      if (!hasText(input.discussed_with_consultant)) {
        errors.discussed_with_consultant = "Required when declining a referral.";
      }
      break;
  }

  return { isValid: Object.keys(errors).length === 0, fieldErrors: errors };
}
