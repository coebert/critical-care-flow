import { createFileRoute } from "@tanstack/react-router";
import { jsonResponse, preflight } from "@/lib/bridge-cors";
import {
  parseBridgeBody,
  pickAllowed,
  verifyBridgeRequest,
} from "@/lib/bridge-verify.server";

const BED_OUTLIER_COLUMNS = [
  "id",
  "hospital_number",
  "patient_initials",
  "ward",
  "admitting_consultant",
  "started_at",
  "ended_at",
  "level",
  "ventilated",
  "nippv_cpap",
  "hfno",
  "vasopressors",
  "renal_replacement",
  "reason",
  "notes",
  "deleted_at",
] as const;

export const Route = createFileRoute("/api/public/bridge/bed_outliers")({
  server: {
    handlers: {
      OPTIONS: async () => preflight(),

      GET: async ({ request }) => {
        const verified = await verifyBridgeRequest(request);
        if (verified instanceof Response) return verified;

        const url = new URL(request.url);
        const since = url.searchParams.get("since");
        const limit = Math.min(
          Number(url.searchParams.get("limit") ?? "500") || 500,
          1000,
        );

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );
        let q = supabaseAdmin
          .from("bed_outliers")
          .select("*")
          .order("updated_at", { ascending: true })
          .limit(limit);
        if (since) q = q.gt("updated_at", since);

        const { data, error } = await q;
        if (error) return jsonResponse({ error: error.message }, { status: 500 });
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

        const picked = pickAllowed(parsed.record, BED_OUTLIER_COLUMNS);
        if ("error" in picked) return jsonResponse(picked, { status: 400 });
        const record = picked.data;

        for (const required of ["ward", "started_at", "level"]) {
          if (record[required] === undefined || record[required] === null) {
            return jsonResponse(
              { error: `${required}_required` },
              { status: 400 },
            );
          }
        }

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );

        if (record.id && parsed.expectedUpdatedAt) {
          const { data: existing } = await supabaseAdmin
            .from("bed_outliers")
            .select("id, updated_at")
            .eq("id", record.id as string)
            .maybeSingle();
          if (existing && existing.updated_at !== parsed.expectedUpdatedAt) {
            const { data: full } = await supabaseAdmin
              .from("bed_outliers")
              .select("*")
              .eq("id", record.id as string)
              .maybeSingle();
            return jsonResponse(
              { error: "concurrent_modification", current: full },
              { status: 409 },
            );
          }
        }

        const { data, error } = await supabaseAdmin
          .from("bed_outliers")
          .upsert(record as any, { onConflict: "id" })
          .select("*")
          .single();
        if (error) return jsonResponse({ error: error.message }, { status: 500 });

        await supabaseAdmin.from("audit_log").insert({
          user_id: null,
          action: "update",
          entity: "bed_outlier",
          entity_id: data.id,
          diff: {
            source: "handover_bridge",
            actor: verified.actor,
            record: record as any,
          },
        });

        return jsonResponse({ record: data });
      },
    },
  },
});
