import { createFileRoute } from "@tanstack/react-router";
import { jsonResponse, preflight } from "@/lib/bridge-cors";
import {
  parseBridgeBody,
  pickAllowed,
  verifyBridgeRequest,
} from "@/lib/bridge-verify.server";

const BED_COLUMNS = [
  "id",
  "code",
  "unit",
  "is_side_room",
  "notes",
  "active",
  "sort_order",
] as const;

export const Route = createFileRoute("/api/public/bridge/beds")({
  server: {
    handlers: {
      OPTIONS: async () => preflight(),

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
          .from("beds")
          .select("*")
          .order("updated_at", { ascending: true })
          .limit(limit);
        if (since) q = q.gt("updated_at", since);

        const { data, error } = await q;
        if (error) return jsonResponse({ error: error.message }, { status: 500 });
        return jsonResponse({ records: data ?? [] });
      },

      POST: async ({ request }) => {
        const verified = await verifyBridgeRequest(request, {
          requireWrite: true,
        });
        if (verified instanceof Response) return verified;

        const parsed = parseBridgeBody(verified.rawBody);
        if ("error" in parsed) {
          return jsonResponse({ error: parsed.error }, { status: 400 });
        }

        const picked = pickAllowed(parsed.record, BED_COLUMNS);
        if ("error" in picked) return jsonResponse(picked, { status: 400 });
        const record = picked.data;

        for (const required of ["code", "unit"]) {
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
          .from("beds")
          .upsert(record as any, { onConflict: "id" })
          .select("*")
          .single();
        if (error) return jsonResponse({ error: error.message }, { status: 500 });

        await supabaseAdmin.from("audit_log").insert({
          user_id: null,
          action: "update",
          entity: "bed",
          entity_id: data.id,
          diff: {
            source: "handover_bridge",
            actor: verified.actor,
            record: record as any,
          },
        });

        return jsonResponse({ record: data });
      },
    },
  },
});
