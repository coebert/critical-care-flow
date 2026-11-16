import { createFileRoute } from "@tanstack/react-router";
import { jsonResponse, preflight } from "@/lib/bridge-cors";
import { refuseRetiredInboundWrite } from "@/lib/bridge-inbound-retired.server";
import { verifyBridgeRequest } from "@/lib/bridge-verify.server";
import {
  auditBridgeNormalizationEvents,
  normalizeIncomingBridgeRecord,
} from "@/lib/bridge-normalize";

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
      OPTIONS: async ({ request }) => preflight(request),

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

      // Inbound mirror writes are retired (see bridge-inbound-retired.server.ts).
      POST: async ({ request }) => refuseRetiredInboundWrite(request, "bed_outliers"),
    },
  },
});
