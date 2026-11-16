import { createFileRoute } from "@tanstack/react-router";
import { preflight } from "@/lib/bridge-cors";
import { runBridgeSync } from "./sync";

/**
 * RETIRED mirror retry endpoint. Authenticates the caller, counts resources
 * with legacy failures, and reports them as not applicable without retrying
 * or changing their state.
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
