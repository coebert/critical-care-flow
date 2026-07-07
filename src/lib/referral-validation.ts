// ICNARC timing + decision-field validation for critical-care referrals.
// Returns per-field error messages plus a list of cross-field issues.

export type ReferralStatus = "pending" | "accepted" | "admitted" | "declined" | string;

export type ReferralTimingInput = {
  status: ReferralStatus;
  referral_received_at: string | null | undefined;
  first_seen_at: string | null | undefined;
  decision_at: string | null | undefined;
  arrived_on_unit_at: string | null | undefined;
};

export type ReferralDecisionInput = {
  status: ReferralStatus;
  decline_reason?: string | null;
  discussed_with_consultant?: string | null;
  accepting_consultant?: string | null;
  admission_urgency?: string | null;
};

export type ReferralFieldInput = ReferralTimingInput & ReferralDecisionInput;

export type TimingField =
  | "referral_received_at"
  | "first_seen_at"
  | "decision_at"
  | "arrived_on_unit_at";

export type DecisionField =
  | "decline_reason"
  | "discussed_with_consultant"
  | "accepting_consultant"
  | "admission_urgency";

export type ReferralField = TimingField | DecisionField;

export type TimingValidation = {
  fieldErrors: Partial<Record<TimingField, string>>;
  issues: string[];
  isValid: boolean;
};

export type ReferralValidation = {
  fieldErrors: Partial<Record<ReferralField, string>>;
  issues: string[];
  isValid: boolean;
};

const toDate = (v: string | null | undefined): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const trimmed = (v: string | null | undefined): string => (v ?? "").trim();

/** Maximum age (in days) allowed for `referral_received_at`. */
export const MAX_REFERRAL_AGE_DAYS = 30;

export type ReferralValidationOptions = {
  /** Skip the MAX_REFERRAL_AGE_DAYS past-cap check on referral_received_at.
   *  Set on update handlers so editing an older referral doesn't fail. */
  ignorePastCap?: boolean;
};

export function validateReferralTimings(
  input: ReferralTimingInput,
  opts: ReferralValidationOptions = {},
): TimingValidation {
  const fieldErrors: Partial<Record<TimingField, string>> = {};
  const issues: string[] = [];
  const now = new Date();
  // Allow up to 2 minutes of clock skew when comparing to "now".
  const futureCap = new Date(now.getTime() + 2 * 60 * 1000);
  const pastCap = new Date(now.getTime() - MAX_REFERRAL_AGE_DAYS * 24 * 60 * 60 * 1000);

  const received = toDate(input.referral_received_at);
  const firstSeen = toDate(input.first_seen_at);
  const decision = toDate(input.decision_at);
  const arrived = toDate(input.arrived_on_unit_at);

  // Required fields per ICNARC dataset
  if (!received) fieldErrors.referral_received_at = "Required — when the referral was received.";
  else if (!opts.ignorePastCap && received < pastCap) {
    fieldErrors.referral_received_at = `Received time is more than ${MAX_REFERRAL_AGE_DAYS} days ago — please check the date.`;
  }

  if (input.status !== "pending") {
    if (!firstSeen) fieldErrors.first_seen_at = "Required once the patient has been reviewed.";
    if (!decision) fieldErrors.decision_at = "Required once a decision has been made.";
  }
  if (input.status === "admitted" && !arrived) {
    fieldErrors.arrived_on_unit_at = "Required for admitted patients.";
  }
  if (input.status === "declined" && arrived) {
    fieldErrors.arrived_on_unit_at = "Declined referrals should not have an arrival time.";
  }
  if (input.status === "pending" && arrived) {
    fieldErrors.arrived_on_unit_at =
      "Pending referrals should not have an arrival time — set the status to Admitted first.";
  }

  // Not-in-the-future checks
  const futureChecks: [TimingField, Date | null, string][] = [
    ["referral_received_at", received, "Received time"],
    ["first_seen_at", firstSeen, "First-seen time"],
    ["decision_at", decision, "Decision time"],
    ["arrived_on_unit_at", arrived, "Arrival time"],
  ];
  for (const [key, d, label] of futureChecks) {
    if (d && d > futureCap) {
      fieldErrors[key] = `${label} cannot be in the future.`;
    }
  }

  // Ordering: received ≤ first seen ≤ decision ≤ arrived
  if (received && firstSeen && firstSeen < received) {
    fieldErrors.first_seen_at = fieldErrors.first_seen_at ?? "First-seen time is before referral received.";
    issues.push("Patient was 'first seen' before the referral was received.");
  }
  if (firstSeen && decision && decision < firstSeen) {
    fieldErrors.decision_at = fieldErrors.decision_at ?? "Decision time is before first seen.";
    issues.push("Decision was made before the patient was first seen.");
  } else if (received && decision && decision < received) {
    fieldErrors.decision_at = fieldErrors.decision_at ?? "Decision time is before referral received.";
    issues.push("Decision was made before the referral was received.");
  }
  if (decision && arrived && arrived < decision) {
    fieldErrors.arrived_on_unit_at = fieldErrors.arrived_on_unit_at ?? "Arrival time is before the decision.";
    issues.push("Patient arrived on the unit before the decision to admit.");
  } else if (received && arrived && arrived < received) {
    fieldErrors.arrived_on_unit_at = fieldErrors.arrived_on_unit_at ?? "Arrival time is before referral received.";
    issues.push("Patient arrived on the unit before the referral was received.");
  }

  return {
    fieldErrors,
    issues,
    isValid: Object.keys(fieldErrors).length === 0 && issues.length === 0,
  };
}

/**
 * Validates the status-dependent decision/admission fields — decline reason,
 * discussed / accepting consultants, and admission urgency — against the
 * current referral status. Used alongside `validateReferralTimings` (or via
 * the combined `validateReferralAll`) so every save enforces both required
 * fields and logical consistency (e.g. a declined referral cannot carry an
 * accepting consultant or admission urgency).
 */
export function validateReferralDecisionFields(
  input: ReferralDecisionInput,
): { fieldErrors: Partial<Record<DecisionField, string>>; issues: string[]; isValid: boolean } {
  const fieldErrors: Partial<Record<DecisionField, string>> = {};
  const issues: string[] = [];

  const declineReason = trimmed(input.decline_reason);
  const discussed = trimmed(input.discussed_with_consultant);
  const accepting = trimmed(input.accepting_consultant);
  const urgency = trimmed(input.admission_urgency);

  if (input.status === "declined") {
    if (!declineReason) {
      fieldErrors.decline_reason = "A reason is required when declining a referral.";
    }
    if (!discussed) {
      fieldErrors.discussed_with_consultant =
        "Record which critical care consultant the referral was discussed with.";
    }
    if (accepting) {
      fieldErrors.accepting_consultant =
        "Declined referrals should not carry an accepting consultant.";
      issues.push("Declined referral has an accepting consultant recorded.");
    }
    if (urgency && urgency !== "not_admitting") {
      fieldErrors.admission_urgency =
        "Declined referrals should not have an admission urgency.";
      issues.push("Declined referral has an admission urgency recorded.");
    }
  }

  if (input.status === "accepted" || input.status === "admitted") {
    if (!accepting) {
      fieldErrors.accepting_consultant =
        "An accepting critical care consultant is required when the referral is Accepted or Admitted.";
    }
    if (declineReason) {
      fieldErrors.decline_reason =
        "Remove the decline reason — this referral is not declined.";
      issues.push(`Decline reason recorded on a ${input.status} referral.`);
    }
  }

  if (input.status === "admitted") {
    if (!urgency || urgency === "not_admitting") {
      fieldErrors.admission_urgency = "Select the admission urgency for admitted patients.";
    }
  }

  if (input.status === "pending") {
    if (declineReason) {
      fieldErrors.decline_reason =
        "Remove the decline reason while the referral is still pending.";
      issues.push("Pending referral has a decline reason recorded.");
    }
    if (accepting) {
      fieldErrors.accepting_consultant =
        "Remove the accepting consultant while the referral is still pending.";
      issues.push("Pending referral has an accepting consultant recorded.");
    }
  }

  return {
    fieldErrors,
    issues,
    isValid: Object.keys(fieldErrors).length === 0 && issues.length === 0,
  };
}

/**
 * Combined validator covering both timings and decision/admission fields.
 * Prefer this at every save site so the same rules apply everywhere.
 */
export function validateReferralAll(input: ReferralFieldInput): ReferralValidation {
  const timing = validateReferralTimings(input);
  const decision = validateReferralDecisionFields(input);
  const fieldErrors: Partial<Record<ReferralField, string>> = {
    ...timing.fieldErrors,
    ...decision.fieldErrors,
  };
  const issues = [...timing.issues, ...decision.issues];
  return {
    fieldErrors,
    issues,
    isValid: Object.keys(fieldErrors).length === 0 && issues.length === 0,
  };
}
