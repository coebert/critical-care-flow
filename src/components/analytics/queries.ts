import { supabase } from "@/integrations/supabase/client";
import { endOfDay, startOfDay, subDays } from "date-fns";

/**
 * Deterministic "initial 30 days" window so the loader and the first
 * component render agree on the queryKey. `startOfDay`/`endOfDay`
 * normalise the clock regardless of the millisecond the code runs at.
 */
export function initialAnalyticsRange() {
  const to = endOfDay(new Date());
  const from = startOfDay(subDays(new Date(), 29));
  return {
    from,
    to,
    fromIso: from.toISOString(),
    toIso: to.toISOString(),
    // Date-only keys MUST be derived in local time. Slicing the UTC ISO
    // string shifts the day for any non-UTC timezone (e.g. British Summer
    // Time), which made the loader prefetch a different queryKey than the
    // panels read — the prefetch was silently wasted and the panel refetched.
    fromDateKey: localDateKey(from),
    toDateKey: localDateKey(to),
  };
}

/** yyyy-MM-dd in the viewer's local timezone. */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Shared queryOptions for the single-row `icnarc_targets` table. Referenced
 * by both the route loader (for prefetch) and the panel component so the
 * queryKey and queryFn are defined exactly once.
 */
export const icnarcTargetsQueryOptions = {
  queryKey: ["icnarc-targets"] as const,
  queryFn: async () => {
    const { data, error } = await supabase
      .from("icnarc_targets")
      .select("time_to_seen_target_min, decision_to_arrival_target_min")
      .maybeSingle();
    if (error) throw error;
    return data;
  },
};
