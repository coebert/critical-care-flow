import { createFileRoute } from "@tanstack/react-router";
import { jsonResponse, preflight } from "@/lib/bridge-cors";
import { classifyBridgeHost } from "@/lib/bridge-runtime";
import { MAX_SYNC_LIMIT, SYNC_SCHEMA_VERSION } from "@/lib/bridge-sync-feed.server";

// Unauthenticated, so it reports configuration PRESENCE and contract
// metadata only — never secret values, signatures or records.
export const Route = createFileRoute("/api/public/bridge/health")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => preflight(request),
      GET: async ({ request }) => {
        return jsonResponse({
          ok: true,
          service: "critical-care-connect-bridge",
          secret_configured: Boolean(process.env.HANDOVER_API_SECRET),
          previous_secret_configured: Boolean(process.env.HANDOVER_API_SECRET_PREVIOUS),
          partner_url_configured: Boolean(process.env.PARTNER_BRIDGE_URL),
          runtime: classifyBridgeHost(new URL(request.url).host),
          contract: {
            sync_schema_version: SYNC_SCHEMA_VERSION,
            max_sync_limit: MAX_SYNC_LIMIT,
            sync_paths: ["referrals", "investigations", "microbiology", "patients"].map(
              (r) => `/api/public/bridge/${r}?sync=1`,
            ),
            signing: "HMAC-SHA256 over `${x-timestamp}.${x-actor}.${rawBody}`, rawBody empty for GET",
            inbound_writes: "retired",
          },
          time: new Date().toISOString(),
        });
      },
    },
  },
});
