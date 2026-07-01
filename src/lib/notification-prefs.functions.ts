import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";

export const getNotificationPrefs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("profiles")
      .select("notify_notes, notify_status")
      .eq("id", userId)
      .maybeSingle();
    if (error) throw safeError("prefs.get", error, "Failed to load notification preferences.");
    return {
      notify_notes: (data as any)?.notify_notes ?? true,
      notify_status: (data as any)?.notify_status ?? true,
    };
  });

export const setNotificationPrefs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        notify_notes: z.boolean().optional(),
        notify_status: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const patch: Record<string, boolean> = {};
    if (typeof data.notify_notes === "boolean") patch.notify_notes = data.notify_notes;
    if (typeof data.notify_status === "boolean") patch.notify_status = data.notify_status;
    if (!Object.keys(patch).length) return { ok: true };
    const { error } = await supabase
      .from("profiles")
      .update(patch as any)
      .eq("id", userId);
    if (error) throw safeError("prefs.set", error, "Failed to update notification preferences.");
    return { ok: true };
  });
