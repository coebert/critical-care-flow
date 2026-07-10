import { createFileRoute } from "@tanstack/react-router";
import { jsonResponse, preflight } from "@/lib/bridge-cors";
import {
  parseBridgeBody,
  pickAllowed,
  verifyBridgeRequest,
} from "@/lib/bridge-verify.server";

const PATIENT_COLUMNS = [
  "id",
  "full_name",
  "hospital_number",
  "nhs_number",
  "dob",
  "location_type",
  "ward",
  "bed",
  "status",
  "admission_date",
  "discharge_date",
  "discharge_destination",
  "date_of_death",
  "past_medical_history",
  "current_admission",
  "current_management",
  "outstanding_tasks",
  "tep_in_place",
  "tep_details",
  "dnacpr_decision",
  "dnacpr_details",
  "dnacpr_date",
  "nok_name",
  "nok_relationship",
  "nok_contact",
  "nok_last_updated",
  "nok_last_updated_by",
] as const;

export const Route = createFileRoute("/api/public/bridge/patients")({
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
          .from("patients")
          .select("*")
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

        const picked = pickAllowed(parsed.record, PATIENT_COLUMNS);
        if ("error" in picked) {
          return jsonResponse(picked, { status: 400 });
        }
        const record = picked.data;
        if (!record.full_name) {
          return jsonResponse(
            { error: "full_name_required" },
            { status: 400 },
          );
        }

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );

        // Optimistic concurrency: if id present + expected_updated_at given,
        // confirm current row's updated_at matches before writing.
        if (record.id && parsed.expectedUpdatedAt) {
          const { data: existing, error: readErr } = await supabaseAdmin
            .from("patients")
            .select("id, updated_at")
            .eq("id", record.id as string)
            .maybeSingle();
          if (readErr) {
            return jsonResponse(
              { error: readErr.message },
              { status: 500 },
            );
          }
          if (
            existing &&
            existing.updated_at !== parsed.expectedUpdatedAt
          ) {
            const { data: full } = await supabaseAdmin
              .from("patients")
              .select("*")
              .eq("id", record.id as string)
              .maybeSingle();
            return jsonResponse(
              {
                error: "concurrent_modification",
                current: full,
              },
              { status: 409 },
            );
          }
        }

        const { data, error } = await supabaseAdmin
          .from("patients")
          .upsert(record as any, { onConflict: "id" })
          .select("*")
          .single();
        if (error) {
          return jsonResponse({ error: error.message }, { status: 500 });
        }

        await supabaseAdmin.from("audit_log").insert({
          user_id: null,
          action: "update",
          entity: "patient",
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
