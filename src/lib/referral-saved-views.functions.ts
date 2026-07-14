import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";

/**
 * Named, per-user filter preset for the referrals list. `params` is stored as
 * JSON so we can evolve the filter set without a migration. RLS scopes reads
 * and writes to `auth.uid()`; a UNIQUE (user_id, name) constraint means one
 * name per user.
 */
export type ReferralSavedView = {
  id: string;
  name: string;
  params: Record<string, unknown>;
  updated_at: string;
};

const NAME_MAX = 60;
const COLS = "id, name, params, updated_at";
const TABLE = "referral_saved_views";

export const listReferralSavedViews = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ReferralSavedView[]> => {
    const { data, error } = await context.supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from(TABLE as any)
      .select(COLS)
      .order("updated_at", { ascending: false });
    if (error) throw safeError("saved-views", error, "Could not load saved views");
    return (data ?? []) as unknown as ReferralSavedView[];
  });

export const upsertReferralSavedView = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        name: z.string().trim().min(1).max(NAME_MAX),
        params: z.record(z.string(), z.unknown()).default({}),
      })
      .parse(data),
  )
  .handler(async ({ data, context }): Promise<ReferralSavedView> => {
    const row = {
      user_id: context.userId,
      name: data.name,
      params: data.params,
    };
    const { data: saved, error } = await context.supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from(TABLE as any)
      .upsert(row, { onConflict: "user_id,name" })
      .select(COLS)
      .single();
    if (error) throw safeError("saved-views", error, "Could not save view");
    return saved as unknown as ReferralSavedView;
  });

export const deleteReferralSavedView = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => z.object({ id: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const { error } = await context.supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from(TABLE as any)
      .delete()
      .eq("id", data.id);
    if (error) throw safeError("saved-views", error, "Could not delete view");
    return { ok: true };
  });
