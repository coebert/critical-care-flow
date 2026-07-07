import type { Referral } from "./referrals-list-utils";

export type QuickFilterKey =
  | "all"
  | "awaiting_review"
  | "awaiting_bed"
  | "accepted_not_arrived"
  | "discussed_pending";

export const QUICK_FILTER_LABEL: Record<QuickFilterKey, string> = {
  all: "All",
  awaiting_review: "Awaiting review",
  awaiting_bed: "Awaiting bed",
  accepted_not_arrived: "Accepted, not arrived",
  discussed_pending: "Discussed, no outcome",
};

export function matchesQuickFilter(r: Referral, key: QuickFilterKey): boolean {
  switch (key) {
    case "all":
      return true;
    case "awaiting_review":
      return r.status === "pending" && !r.outcome;
    case "awaiting_bed":
      return r.outcome === "admit_for_admission" && r.status !== "admitted";
    case "accepted_not_arrived":
      return r.status === "accepted" && !r.arrived_at;
    case "discussed_pending":
      return !!r.discussed_with_consultant_at && !r.outcome;
  }
}

export function applyQuickFilter(rows: Referral[], key: QuickFilterKey): Referral[] {
  if (key === "all") return rows;
  return rows.filter((r) => matchesQuickFilter(r, key));
}
