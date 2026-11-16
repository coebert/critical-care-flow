import { createFileRoute } from "@tanstack/react-router";
import { jsonResponse, preflight } from "@/lib/bridge-cors";
import { refuseRetiredInboundWrite } from "@/lib/bridge-inbound-retired.server";
import { verifyBridgeRequest } from "@/lib/bridge-verify.server";
import { handleSyncGet, RESOURCE_CONFIG } from "@/lib/bridge-sync-feed.server";

const MICROBIOLOGY_COLUMNS = [
  "id",
  "patient_id",
  "organism",
  "sample_type",
  "sensitivities",
  "sampled_at",
  "reported_at",
  "notes",
] as const;

export const Route = createFileRoute("/api/public/bridge/microbiology")({
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
          return handleSyncGet("microbiology", RESOURCE_CONFIG.microbiology, request, jsonResponse);
        }
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
          .from("microbiology")
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

      // Inbound mirror writes are retired (see bridge-inbound-retired.server.ts).
      POST: async ({ request }) => refuseRetiredInboundWrite(request, "microbiology"),
    },
  },
});
