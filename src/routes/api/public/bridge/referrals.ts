import { createFileRoute } from "@tanstack/react-router";
import { jsonResponse, preflight } from "@/lib/bridge-cors";
import {
  parseBridgeBody,
  pickAllowed,
  verifyBridgeRequest,
} from "@/lib/bridge-verify.server";

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
      OPTIONS: async () => preflight(),

      GET: async ({ request }) => {
        const verified = await verifyBridgeRequest(request);
        if (verified instanceof Response) return verified;

        const url = new URL(request.url);
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
          .select(REFERRAL_COLUMNS.join(","))
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

      POST: async ({ request }) => {
        const verified = await verifyBridgeRequest(request, {
          requireWrite: true,
        });
        if (verified instanceof Response) return verified;

        const parsed = parseBridgeBody(verified.rawBody);
        if ("error" in parsed) {
          return jsonResponse({ error: parsed.error }, { status: 400 });
        }
        const picked = pickAllowed(parsed.record, REFERRAL_COLUMNS);
        if ("error" in picked) return jsonResponse(picked, { status: 400 });
        const record = picked.data;

        if (!record.referral_received_at) {
          return jsonResponse(
            { error: "referral_received_at_required" },
            { status: 400 },
          );
        }

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );

        if (record.id && parsed.expectedUpdatedAt) {
          const { data: existing } = await supabaseAdmin
            .from("referrals")
            .select("id, updated_at")
            .eq("id", record.id as string)
            .maybeSingle();
          if (
            existing &&
            existing.updated_at !== parsed.expectedUpdatedAt
          ) {
            const { data: full } = await supabaseAdmin
              .from("referrals")
              .select(REFERRAL_COLUMNS.join(","))
              .eq("id", record.id as string)
              .maybeSingle();
            return jsonResponse(
              { error: "concurrent_modification", current: full },
              { status: 409 },
            );
          }
        }

        const { data, error } = await supabaseAdmin
          .from("referrals")
          .upsert(record as any, { onConflict: "id" })
          .select(REFERRAL_COLUMNS.join(","))
          .single();
        if (error) {
          return jsonResponse({ error: error.message }, { status: 500 });
        }

        await supabaseAdmin.from("audit_log").insert({
          user_id: null,
          action: "update",
          entity: "referral",
          entity_id: (data as any)?.id,
          diff: {
            source: "handover_bridge",
            actor: verified.actor,
            record: record as any,
          } as any,
        });

        return jsonResponse({ record: data });
      },
    },
  },
});
