import { createFileRoute } from "@tanstack/react-router";
import { preflight } from "@/lib/bridge-cors";
import { runBridgeSync } from "./sync";

/**
 * Retries only the resources currently in a failed state (bridge_sync_state.last_error IS NOT NULL).
 * Each attempt is written to bridge_sync_attempts with source='retry' for admin visibility.
 * Safe to schedule frequently — becomes a no-op when nothing is failing.
 * Auth: same apikey header pattern as /api/public/bridge/sync.
 */
export const Route = createFileRoute("/api/public/bridge/retry-failed")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => preflight(request),
      GET: async ({ request }) =>
        runBridgeSync(request, { failedOnly: true, source: "retry" }),
      POST: async ({ request }) =>
        runBridgeSync(request, { failedOnly: true, source: "retry" }),
    },
  },
});
