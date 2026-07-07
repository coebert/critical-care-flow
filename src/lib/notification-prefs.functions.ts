import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";

const prefFields = [
  "notify_notes",
  "notify_status",
  "notify_new_referral",
  "notify_updated_referral",
  "notify_capacity",
  "notify_capacity_l3",
  "notify_capacity_l2",
  "notify_capacity_l1",
] as const;

export type NotificationPrefKey = (typeof prefFields)[number];
export type NotificationPrefs = Record<NotificationPrefKey, boolean>;

const defaults: NotificationPrefs = {
  notify_notes: true,
  notify_status: true,
  notify_new_referral: true,
  notify_updated_referral: true,
  notify_capacity: true,
  notify_capacity_l3: true,
  notify_capacity_l2: true,
  notify_capacity_l1: true,
};

export const getNotificationPrefs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("profiles")
      .select(prefFields.join(", "))
      .eq("id", userId)
      .maybeSingle();
    if (error) throw safeError("prefs.get", error, "Failed to load notification preferences.");
    const row = (data ?? {}) as Partial<Record<NotificationPrefKey, boolean | null>>;
    const out = { ...defaults };
    for (const k of prefFields) {
      if (typeof row[k] === "boolean") out[k] = row[k] as boolean;
    }
    return out;
  });

export const setNotificationPrefs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object(
        Object.fromEntries(prefFields.map((f) => [f, z.boolean().optional()])) as Record<
          NotificationPrefKey,
          z.ZodOptional<z.ZodBoolean>
        >,
      )
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const patch: Partial<NotificationPrefs> = {};
    for (const k of prefFields) {
      if (typeof data[k] === "boolean") patch[k] = data[k] as boolean;
    }
    if (!Object.keys(patch).length) return { ok: true };
    const { error } = await supabase
      .from("profiles")
      .update(patch as any)
      .eq("id", userId);
    if (error) throw safeError("prefs.set", error, "Failed to update notification preferences.");
    return { ok: true };
  });
