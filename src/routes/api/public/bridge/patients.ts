import { createFileRoute } from "@tanstack/react-router";
import { jsonResponse, preflight } from "@/lib/bridge-cors";
import { refuseRetiredInboundWrite } from "@/lib/bridge-inbound-retired.server";
import { verifyBridgeRequest } from "@/lib/bridge-verify.server";
import { handleSyncGet, RESOURCE_CONFIG } from "@/lib/bridge-sync-feed.server";

const PATIENT_COLUMNS = [
  "id",
  // `patient_initials` is the wire field. It maps to the local `full_name`
  // column (which we reuse as the initials carrier). `full_name` is kept
  // in the allowlist purely for backwards-compat with older partner
  // clients that have not yet switched over; new pushes only send
  // `patient_initials`.
  "patient_initials",
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
      OPTIONS: async ({ request }) => preflight(request),

      GET: async ({ request }) => {
        const verified = await verifyBridgeRequest(request);
        if (verified instanceof Response) return verified;

        const url = new URL(request.url);
        // Versioned, paginated snapshot feed (Hub sync). Default GET below
        // is unchanged for older readers.
        if (url.searchParams.get("sync") === "1") {
          return handleSyncGet("patients", RESOURCE_CONFIG.patients, request, jsonResponse);
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

      // Inbound mirror writes are retired (see bridge-inbound-retired.server.ts).
      POST: async ({ request }) => refuseRetiredInboundWrite(request, "patients"),
    },
  },
});
