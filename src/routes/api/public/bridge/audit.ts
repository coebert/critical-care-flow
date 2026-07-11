import { createFileRoute } from "@tanstack/react-router";
import { jsonResponse, preflight } from "@/lib/bridge-cors";
import { actorIsAdmin } from "@/lib/bridge-actor";
import { verifyBridgeRequest } from "@/lib/bridge-verify.server";

/**
 * Audit log — read-only, admin actor only.
 * Filters: ?entity=patient&entity_id=<uuid>&since=<iso>&limit=200
 */
export const Route = createFileRoute("/api/public/bridge/audit")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => preflight(request),
      GET: async ({ request }) => {
        const verified = await verifyBridgeRequest(request);
        if (verified instanceof Response) return verified;
        if (!actorIsAdmin(verified.actor)) {
          return jsonResponse(
            { error: "admin_actor_required" },
            { status: 403 },
          );
        }

        const url = new URL(request.url);
        const entity = url.searchParams.get("entity");
        const entityId = url.searchParams.get("entity_id");
        const since = url.searchParams.get("since");
        const limit = Math.min(
          Number(url.searchParams.get("limit") ?? "200") || 200,
          1000,
        );

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );
        let q = supabaseAdmin
          .from("audit_log")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(limit);
        if (entity) q = q.eq("entity", entity);
        if (entityId) q = q.eq("entity_id", entityId);
        if (since) q = q.gt("created_at", since);

        const { data, error } = await q;
        if (error) {
          return jsonResponse({ error: error.message }, { status: 500 });
        }
        return jsonResponse({ records: data ?? [] });
      },
    },
  },
});
