// Admin-only history of capacity-crossing push alerts.
// Notifications are fanned out per user with the same message and near-identical
// created_at timestamps, so we dedupe by (message, second) to get one row per
// alert event.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const inputSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
});

export interface CapacityAlertEvent {
  sent_at: string;
  message: string;
  recipient_count: number;
}

export const getCapacityAlertHistory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { limit?: number }) => inputSchema.parse(data))
  .handler(async ({ data, context }): Promise<CapacityAlertEvent[]> => {
    const { data: isAdmin, error: roleErr } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });
    if (roleErr) throw roleErr;
    if (!isAdmin) throw new Error("Forbidden");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const limit = data.limit ?? 100;

    // Pull enough raw rows to reconstruct ~limit distinct events. Each event
    // fans out to N recipients (typically < 50 at-work users).
    const { data: rows, error } = await supabaseAdmin
      .from("notifications")
      .select("created_at, message")
      .eq("kind", "capacity")
      .order("created_at", { ascending: false })
      .limit(limit * 100);
    if (error) throw error;

    const groups = new Map<string, CapacityAlertEvent>();
    for (const r of rows ?? []) {
      const sec = new Date(r.created_at as string).toISOString().slice(0, 19);
      const key = `${sec}|${r.message}`;
      const existing = groups.get(key);
      if (existing) {
        existing.recipient_count += 1;
      } else {
        groups.set(key, {
          sent_at: r.created_at as string,
          message: r.message as string,
          recipient_count: 1,
        });
      }
    }

    return Array.from(groups.values())
      .sort((a, b) => (a.sent_at < b.sent_at ? 1 : -1))
      .slice(0, limit);
  });
