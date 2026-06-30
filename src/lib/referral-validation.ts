// ICNARC timing validation for critical-care referrals.
// Returns per-field error messages plus a list of cross-field issues.

export type ReferralTimingInput = {
  status: "pending" | "accepted" | "admitted" | "declined" | string;
  referral_received_at: string | null | undefined;
  first_seen_at: string | null | undefined;
  decision_at: string | null | undefined;
  arrived_on_unit_at: string | null | undefined;
};

export type TimingField =
  | "referral_received_at"
  | "first_seen_at"
  | "decision_at"
  | "arrived_on_unit_at";

export type TimingValidation = {
  fieldErrors: Partial<Record<TimingField, string>>;
  issues: string[];
  isValid: boolean;
};

const toDate = (v: string | null | undefined): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Maximum age (in days) allowed for `referral_received_at`. */
export const MAX_REFERRAL_AGE_DAYS = 30;

export function validateReferralTimings(input: ReferralTimingInput): TimingValidation {
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
  else if (received < pastCap) {
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

  // Decline reason vs status handled elsewhere — this validator covers timing only.

  return {
    fieldErrors,
    issues,
    isValid: Object.keys(fieldErrors).length === 0 && issues.length === 0,
  };
}
