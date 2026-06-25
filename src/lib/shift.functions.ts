import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";

export const getShiftStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("profiles")
      .select("is_at_work, shift_updated_at")
      .eq("id", userId)
      .maybeSingle();
    if (error) throw safeError("shift.get", error, "Failed to load shift status.");
    return {
      is_at_work: !!(data as any)?.is_at_work,
      shift_updated_at: (data as any)?.shift_updated_at ?? null,
    };
  });

export const setShiftStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ is_at_work: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("profiles")
      .update({
        is_at_work: data.is_at_work,
        shift_updated_at: new Date().toISOString(),
      } as any)
      .eq("id", userId);
    if (error) throw safeError("shift.set", error, "Failed to update shift status.");
    return { ok: true, is_at_work: data.is_at_work };
  });

const subSchema = z.object({
  endpoint: z.string().url().max(2000),
  p256dh: z.string().min(1).max(500),
  auth: z.string().min(1).max(500),
  user_agent: z.string().max(500).optional(),
});

export const subscribePush = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => subSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    // Push endpoints are globally unique. Registration goes through a
    // SECURITY DEFINER RPC so the database can atomically claim/refresh the
    // endpoint for the authenticated user, even when the same browser endpoint
    // was previously registered by another account. This avoids depending on
    // service-role environment configuration from the app runtime.
    const { error } = await supabase.rpc("claim_push_subscription", {
      p_endpoint: data.endpoint,
      p_p256dh: data.p256dh,
      p_auth: data.auth,
      p_user_agent: data.user_agent ?? null,
    });
    if (error) throw safeError("push.subscribe", error, "Failed to register for push notifications.");
    return { ok: true };
  });

export const unsubscribePush = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ endpoint: z.string().url() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("push_subscriptions")
      .delete()
      .eq("user_id", userId)
      .eq("endpoint", data.endpoint);
    if (error) throw safeError("push.unsubscribe", error, "Failed to unsubscribe.");
    return { ok: true };
  });
