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
  return { from, to, fromIso: from.toISOString(), toIso: to.toISOString() };
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
