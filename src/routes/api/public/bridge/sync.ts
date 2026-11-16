import { createFileRoute } from "@tanstack/react-router";
import { jsonResponse, preflight } from "@/lib/bridge-cors";
import { isBridgeCallerAuthorized } from "@/lib/bridge-caller-auth.server";
import { retiredBridgeStatus } from "@/lib/bridge-mirror-retired";

/**
 * RETIRED mirror sync endpoint (see src/lib/bridge-mirror-retired.ts).
 *
 * Still authenticates the caller first. Returns a truthful "retired" status
 * and performs no pulls, pushes, upserts, cursor advances or retries. Legacy
 * failure rows are counted (no contents) and left untouched.
 */
export async function runBridgeSync(
  request: Request,
  opts: { failedOnly?: boolean; bedsOnly?: boolean; source?: "sync" | "retry" | "manual" } = {},
): Promise<Response> {
  if (!(await isBridgeCallerAuthorized(request))) {
    return jsonResponse({ error: "unauthorized" }, { status: 401 });
  }
  if (!opts.failedOnly) return jsonResponse(retiredBridgeStatus());
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { count, error } = await supabaseAdmin
      .from("bridge_sync_state")
      .select("resource", { count: "exact", head: true })
      .not("last_error", "is", null);
    if (error || count === null) {
      return jsonResponse({ ...retiredBridgeStatus(), ok: false, error: "failure_count_unavailable" }, { status: 503 });
    }
    return jsonResponse({ ...retiredBridgeStatus(), failures: { status: "not_applicable", count, retained: true } });
  } catch {
    return jsonResponse({ ...retiredBridgeStatus(), ok: false, error: "failure_count_unavailable" }, { status: 503 });
  }
}

export const Route = createFileRoute("/api/public/bridge/sync")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => preflight(request),
      GET: async ({ request }) => runBridgeSync(request, { source: "sync" }),
      POST: async ({ request }) => runBridgeSync(request, { source: "sync" }),
    },
  },
});
