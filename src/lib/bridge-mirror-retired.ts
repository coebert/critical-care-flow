/**
 * The old bidirectional "mirror" bridge sync is RETIRED.
 *
 * Ownership contract:
 *   - ICU Handover Hub owns patients and bed placement. CCC reads them
 *     directly and live (partner-bed-board.server.ts / hub-client.server.ts).
 *   - CCC owns referrals; the Hub PULLS CCC's versioned `?sync=1` feed.
 *
 * The legacy endpoints stay reachable (cron and admin callers still hit
 * them) but perform NO mutations: nothing is pulled into local copies,
 * nothing is pushed, no cursor advances and failures are left in place.
 */
export const RETIRED_MESSAGE =
  "Not applicable — ICU Handover Hub is the source of patients and placement; the Hub pulls referrals from this app.";

export function retiredBridgeStatus() {
  return {
    ok: true as const,
    mode: "retired" as const,
    message: RETIRED_MESSAGE,
    status: {
      patients: "source_owned_by_hub",
      placement: "source_owned_by_hub",
      referrals: "hub_pulls_ccc_v1_feed",
      bed_board: "direct_read",
    },
    mutations: 0 as const,
  };
}
