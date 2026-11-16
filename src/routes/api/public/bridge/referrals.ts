import { createFileRoute } from "@tanstack/react-router";
import { jsonResponse, preflight } from "@/lib/bridge-cors";
import { refuseRetiredInboundWrite } from "@/lib/bridge-inbound-retired.server";
import { verifyBridgeRequest } from "@/lib/bridge-verify.server";
import { handleSyncGet, referralResourceConfig } from "@/lib/bridge-sync-feed.server";

// Encrypted columns (_enc, _hash) are intentionally excluded — those payloads
// require this app's local encryption keys and cannot flow through the bridge.
const REFERRAL_COLUMNS = [
  "id",
  "age",
  "sex",
  "current_ward",
  "current_bed",
  "dnacpr_respect",
  "referring_specialty",
  "referral_received_at",
  "first_seen_at",
  "decision_at",
  "arrived_on_unit_at",
  "status",
  "decline_reason",
  "admission_urgency",
  "consultant_to_consultant_only",
  "accepting_consultant",
  "discussed_with_consultant",
  "is_test",
  "news2_score",
  "news2_recorded_at",
  "ceiling_of_care",
  "reason_category",
  "frailty_score",
  "anticipated_interventions",
  "infection_status",
  "infection_organism",
  "weight_kg",
  "allergies",
  "resus_status",
  "previous_referral_id",
  "outcome",
  "outcome_recorded_at",
  "needs_ward_review",
  "ward_review_timeframe",
  "for_ongoing_ccot_review",
] as const;

export const Route = createFileRoute("/api/public/bridge/referrals")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => preflight(request),

      GET: async ({ request }) => {
        const verified = await verifyBridgeRequest(request);
        if (verified instanceof Response) return verified;

        const url = new URL(request.url);
        // Versioned, paginated snapshot feed (Hub sync). Default GET below
        // is unchanged for older readers.
        if (url.searchParams.get("sync") === "1") {
          return handleSyncGet("referrals", referralResourceConfig(REFERRAL_COLUMNS), request, jsonResponse);
        }
        const status = url.searchParams.get("status");
        const since = url.searchParams.get("since");
        const limit = Math.min(
          Number(url.searchParams.get("limit") ?? "500") || 500,
          1000,
        );

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );
        let q = supabaseAdmin
          .from("referrals")
          // created_at/updated_at are read-only extras (never writable via
          // POST) so readers can detect updates.
          .select([...REFERRAL_COLUMNS, "created_at", "updated_at"].join(","))
          .is("deleted_at", null)
          .order("updated_at", { ascending: true })
          .limit(limit);
        if (status) q = q.eq("status", status as any);
        if (since) q = q.gt("updated_at", since);

        const { data, error } = await q;
        if (error) {
          return jsonResponse({ error: error.message }, { status: 500 });
        }
        return jsonResponse({ records: data ?? [] });
      },

      // Inbound mirror writes are retired (see bridge-inbound-retired.server.ts).
      POST: async ({ request }) => refuseRetiredInboundWrite(request, "referrals"),
    },
  },
});
