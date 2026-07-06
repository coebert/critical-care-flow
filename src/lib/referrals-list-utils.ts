import type { Tables } from "@/integrations/supabase/types";
import type { DecryptedReferral } from "@/lib/referrals.functions";
import type { AdmissionUrgency } from "@/lib/admission-urgency";

export type Referral = Tables<"referrals"> & DecryptedReferral;

/** Status → badge tint (semantic tokens, not raw palette). */
export const statusStyles: Record<string, string> = {
  pending: "bg-warning/15 text-warning-foreground border-warning/30",
  accepted: "bg-success/15 text-success border-success/30",
  admitted: "bg-success/15 text-success border-success/30",
  declined: "bg-destructive/10 text-destructive border-destructive/30",
};

/** Status → row background wash for card/table rows. */
export const rowBgStyles: Record<string, string> = {
  pending: "bg-warning/[0.08]",
  accepted: "bg-success/[0.08]",
  admitted: "bg-success/[0.08]",
  declined: "bg-destructive/[0.06]",
};

export type StatusKey = "all" | "pending" | "accepted" | "admitted" | "declined";
export type DateKey = "all" | "today" | "yesterday" | "7d" | "30d";
export type PediatricKey = "all" | "pediatric";

export interface ReferralsListFilters {
  hospSearch: string;
  q: string;
  statusFilter: StatusKey;
  urgencyFilter: "all" | AdmissionUrgency;
  locFilter: string;
  dateFilter: DateKey;
  pediatricFilter: PediatricKey;
  /** Optional URL-derived drill-down overrides. */
  drilldown?: { specialty?: string; from?: string; to?: string };
}

/**
 * Pure client-side filter. All heavy filtering happens in the browser once
 * the row set is small; encrypted PHI stays out of URL search params.
 */
export function filterReferrals(rows: Referral[], f: ReferralsListFilters): Referral[] {
  const needle = f.q.trim().toLowerCase();
  const hospNeedle = f.hospSearch.trim().toLowerCase();
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  let fromTs: number | null = null;
  let toTs: number | null = null;
  if (f.dateFilter === "today") fromTs = startOfToday;
  else if (f.dateFilter === "yesterday") { fromTs = startOfToday - 86400000; toTs = startOfToday; }
  else if (f.dateFilter === "7d") fromTs = now.getTime() - 7 * 86400000;
  else if (f.dateFilter === "30d") fromTs = now.getTime() - 30 * 86400000;

  const drill = f.drilldown;
  if (drill?.from) {
    const t = Date.parse(`${drill.from}T00:00:00`);
    if (!Number.isNaN(t)) fromTs = t;
  }
  if (drill?.to) {
    const t = Date.parse(`${drill.to}T00:00:00`);
    if (!Number.isNaN(t)) toTs = t + 86400000; // exclusive upper bound
  }
  const specialtyNeedle = drill?.specialty?.trim().toLowerCase() ?? "";

  return rows.filter((r) => {
    if (f.statusFilter !== "all" && r.status !== f.statusFilter) return false;
    if (f.urgencyFilter !== "all" && r.admission_urgency !== f.urgencyFilter) return false;
    if (f.locFilter !== "all" && r.current_ward !== f.locFilter) return false;
    if (specialtyNeedle && (r.referring_specialty ?? "").trim().toLowerCase() !== specialtyNeedle) return false;
    if (f.pediatricFilter === "pediatric") {
      if (r.age === null || r.age > 16) return false;
    }
    if (fromTs !== null) {
      const t = new Date(r.referral_received_at).getTime();
      if (t < fromTs) return false;
      if (toTs !== null && t >= toTs) return false;
    }
    if (hospNeedle) {
      const hn = (r.hospital_number ?? "").toLowerCase();
      if (!hn.includes(hospNeedle)) return false;
    }
    if (!needle) return true;
    return [r.hospital_number, r.current_ward, r.current_bed, r.referring_specialty, r.reason_for_referral]
      .filter(Boolean)
      .some((v) => v!.toString().toLowerCase().includes(needle));
  });
}

/**
 * Wards ordered by occurrence, capped to the 8 most-common — used to build
 * the location filter chip row without overwhelming small screens.
 */
export function computeTopWards(rows: Referral[], limit = 8): string[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!r.current_ward) continue;
    counts.set(r.current_ward, (counts.get(r.current_ward) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([ward]) => ward);
}

export function sortByTimer(
  rows: Referral[],
  direction: "none" | "desc" | "asc",
  now: number,
): Referral[] {
  if (direction === "none") return rows;
  const dir = direction === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const ea = getTimerElapsedMs(a, now);
    const eb = getTimerElapsedMs(b, now);
    // Rows without an active timer always sort to the bottom.
    if (ea === null && eb === null) return 0;
    if (ea === null) return 1;
    if (eb === null) return -1;
    return (ea - eb) * dir;
  });
}

export function formatElapsed(ms: number): string {
  if (ms < 0) ms = 0;
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

export function getTimerElapsedMs(r: Referral, now: number): number | null {
  if (r.status === "pending") return now - new Date(r.referral_received_at).getTime();
  if (r.status === "accepted" || r.status === "admitted") {
    const startSrc = r.decision_at ?? r.updated_at;
    if (!startSrc) return null;
    const end = r.arrived_on_unit_at ? new Date(r.arrived_on_unit_at).getTime() : now;
    return end - new Date(startSrc).getTime();
  }
  return null;
}

export function getTimerInfo(
  r: Referral,
  now: number,
): { label: string; value: string; tone: string } | null {
  if (r.status === "pending") {
    const start = new Date(r.referral_received_at).getTime();
    return { label: "Waiting", value: formatElapsed(now - start), tone: "text-warning-foreground" };
  }
  if (r.status === "accepted" || r.status === "admitted") {
    const startSrc = r.decision_at ?? r.updated_at;
    if (!startSrc) return null;
    const start = new Date(startSrc).getTime();
    const end = r.arrived_on_unit_at ? new Date(r.arrived_on_unit_at).getTime() : now;
    return {
      label: r.arrived_on_unit_at ? "Time to admission" : "Time waiting for admission",
      value: formatElapsed(end - start),
      tone: "text-success",
    };
  }
  return null;
}
