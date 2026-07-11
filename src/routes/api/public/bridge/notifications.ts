import { createFileRoute } from "@tanstack/react-router";
import { jsonResponse, preflight } from "@/lib/bridge-cors";
import {
  parseBridgeBody,
  pickAllowed,
  verifyBridgeRequest,
} from "@/lib/bridge-verify.server";

const NOTIFICATION_COLUMNS = [
  "id",
  "user_id",
  "referral_id",
  "kind",
  "message",
  "read_at",
] as const;

export const Route = createFileRoute("/api/public/bridge/notifications")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => preflight(request),

      /** List notifications for a specific user_id (query param). */
      GET: async ({ request }) => {
        const verified = await verifyBridgeRequest(request);
        if (verified instanceof Response) return verified;

        const url = new URL(request.url);
        const userId = url.searchParams.get("user_id");
        const since = url.searchParams.get("since");
        const unread = url.searchParams.get("unread") === "true";
        const limit = Math.min(
          Number(url.searchParams.get("limit") ?? "200") || 200,
          1000,
        );

        if (!userId) {
          return jsonResponse(
            { error: "user_id_query_param_required" },
            { status: 400 },
          );
        }

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );
        let q = supabaseAdmin
          .from("notifications")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(limit);
        if (since) q = q.gt("created_at", since);
        if (unread) q = q.is("read_at", null);

        const { data, error } = await q;
        if (error) {
          return jsonResponse({ error: error.message }, { status: 500 });
        }
        return jsonResponse({ records: data ?? [] });
      },

      /** Insert a notification. user_id, kind, message required. */
      POST: async ({ request }) => {
        const verified = await verifyBridgeRequest(request, {
          requireWrite: true,
        });
        if (verified instanceof Response) return verified;

        const parsed = parseBridgeBody(verified.rawBody);
        if ("error" in parsed) {
          return jsonResponse({ error: parsed.error }, { status: 400 });
        }
        const picked = pickAllowed(parsed.record, NOTIFICATION_COLUMNS);
        if ("error" in picked) return jsonResponse(picked, { status: 400 });
        const record = picked.data;

        for (const required of ["user_id", "kind", "message"]) {
          if (!record[required]) {
            return jsonResponse(
              { error: `${required}_required` },
              { status: 400 },
            );
          }
        }

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );
        const { data, error } = await supabaseAdmin
          .from("notifications")
          .insert(record as any)
          .select("*")
          .single();
        if (error) {
          return jsonResponse({ error: error.message }, { status: 500 });
        }

        await supabaseAdmin.from("audit_log").insert({
          user_id: null,
          action: "create",
          entity: "notification",
          entity_id: data.id,
          diff: {
            source: "handover_bridge",
            actor: verified.actor,
            record: record as any,
          } as any,
        });

        return jsonResponse({ record: data });
      },
    },
  },
});
