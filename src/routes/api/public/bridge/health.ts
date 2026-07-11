import { createFileRoute } from "@tanstack/react-router";
import { jsonResponse, preflight } from "@/lib/bridge-cors";

export const Route = createFileRoute("/api/public/bridge/health")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => preflight(request),
      GET: async () => {
        return jsonResponse({
          ok: true,
          service: "critical-care-connect-bridge",
          secret_configured: Boolean(process.env.HANDOVER_API_SECRET),
          previous_secret_configured: Boolean(process.env.HANDOVER_API_SECRET_PREVIOUS),
          partner_url_configured: Boolean(process.env.PARTNER_BRIDGE_URL),
          time: new Date().toISOString(),
        });
      },
    },
  },
});
