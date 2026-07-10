import { createFileRoute } from "@tanstack/react-router";
import { jsonResponse, preflight } from "@/lib/bridge-cors";
import {
  parseBridgeBody,
  pickAllowed,
  verifyBridgeRequest,
} from "@/lib/bridge-verify.server";

const INVESTIGATION_COLUMNS = [
  "id",
  "patient_id",
  "category",
  "findings",
  "result_at",
] as const;

export const Route = createFileRoute("/api/public/bridge/investigations")({
  server: {
    handlers: {
      OPTIONS: async () => preflight(),

      GET: async ({ request }) => {
        const verified = await verifyBridgeRequest(request);
        if (verified instanceof Response) return verified;

        const url = new URL(request.url);
        const patientId = url.searchParams.get("patient_id");
        const since = url.searchParams.get("since");
        const limit = Math.min(
          Number(url.searchParams.get("limit") ?? "500") || 500,
          1000,
        );

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );
        let q = supabaseAdmin
          .from("investigations")
          .select("*")
          .order("updated_at", { ascending: true })
          .limit(limit);
        if (patientId) q = q.eq("patient_id", patientId);
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

        const picked = pickAllowed(parsed.record, INVESTIGATION_COLUMNS);
        if ("error" in picked) return jsonResponse(picked, { status: 400 });
        const record = picked.data;

        for (const required of [
          "patient_id",
          "category",
          "findings",
          "result_at",
        ]) {
          if (!record[required]) {
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
            .from("investigations")
            .select("id, updated_at")
            .eq("id", record.id as string)
            .maybeSingle();
          if (
            existing &&
            existing.updated_at !== parsed.expectedUpdatedAt
          ) {
            const { data: full } = await supabaseAdmin
              .from("investigations")
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
          .from("investigations")
          .upsert(record as any, { onConflict: "id" })
          .select("*")
          .single();
        if (error) {
          return jsonResponse({ error: error.message }, { status: 500 });
        }

        await supabaseAdmin.from("audit_log").insert({
          user_id: null,
          action: "update",
          entity: "investigation",
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
