import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";

export type WardableStatus = {
  partner_patient_id: string;
  wardable: boolean;
  wardable_at: string | null;
  discharged_at: string | null;
  updated_at: string;
};

const COLS =
  "partner_patient_id, wardable, wardable_at, discharged_at, updated_at";

export const listWardableStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<WardableStatus[]> => {
    const { data, error } = await context.supabase
      .from("patient_wardable_status")
      .select(COLS);
    if (error) throw safeError("wardable", error, "Could not load wardable status");
    return (data ?? []) as unknown as WardableStatus[];
  });

const setSchema = z.object({
  partner_patient_id: z.string().min(1).max(200),
  wardable: z.boolean(),
});

/**
 * Toggle wardable status for a partner patient. Preserves the original
 * `wardable_at` timestamp across repeat "wardable=true" writes so the
 * running timer measures true elapsed time from first declaration.
 */
export const setWardableStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => setSchema.parse(d))
  .handler(async ({ data, context }): Promise<WardableStatus> => {
    const { data: existing, error: readErr } = await context.supabase
      .from("patient_wardable_status")
      .select("wardable, wardable_at")
      .eq("partner_patient_id", data.partner_patient_id)
      .maybeSingle();
    if (readErr) throw safeError("wardable", readErr, "Could not read wardable status");

    const nowIso = new Date().toISOString();
    const wardable_at = data.wardable
      ? (existing?.wardable && existing.wardable_at ? existing.wardable_at : nowIso)
      : null;

    const { data: row, error } = await context.supabase
      .from("patient_wardable_status")
      .upsert(
        {
          partner_patient_id: data.partner_patient_id,
          wardable: data.wardable,
          wardable_at,
          // Toggling wardable clears any prior discharge stamp — a fresh
          // discharge window starts. The DB trigger enforces this too.
          discharged_at: null,
          updated_by: context.userId,
          updated_at: nowIso,
        },
        { onConflict: "partner_patient_id" },
      )
      .select(COLS)
      .single();
    if (error) throw safeError("wardable", error, "Could not update wardable status");

    // Best-effort forward to the partner app so the same flag surfaces on
    // their side. Silent failure — the local record is the source of truth
    // for the discharge-latency timer.
    try {
      const { pushWardableToPartner } = await import("./wardable-status.server");
      await pushWardableToPartner({
        partner_patient_id: data.partner_patient_id,
        wardable: data.wardable,
        wardable_at,
        userId: context.userId,
        claims: context.claims as Record<string, unknown>,
      });
    } catch (err) {
      console.warn("[wardable] partner push failed", err);
    }

    return row as unknown as WardableStatus;
  });

const dischargeSchema = z.object({
  partner_patient_id: z.string().min(1).max(200),
  discharged_at: z.string().datetime().optional(),
});

/**
 * Record a discharge for a partner patient. Stamps `discharged_at` so we can
 * measure elapsed time from `wardable_at` → `discharged_at`. Leaves the
 * `wardable` flag and `wardable_at` intact so the historical window is
 * preserved for analytics.
 */
export const dischargePatient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => dischargeSchema.parse(d))
  .handler(async ({ data, context }): Promise<WardableStatus> => {
    const nowIso = data.discharged_at ?? new Date().toISOString();

    const { data: existing, error: readErr } = await context.supabase
      .from("patient_wardable_status")
      .select("wardable, wardable_at")
      .eq("partner_patient_id", data.partner_patient_id)
      .maybeSingle();
    if (readErr) throw safeError("wardable", readErr, "Could not read wardable status");

    const { data: row, error } = await context.supabase
      .from("patient_wardable_status")
      .upsert(
        {
          partner_patient_id: data.partner_patient_id,
          wardable: existing?.wardable ?? false,
          wardable_at: existing?.wardable_at ?? null,
          discharged_at: nowIso,
          updated_by: context.userId,
          updated_at: nowIso,
        },
        { onConflict: "partner_patient_id" },
      )
      .select(COLS)
      .single();
    if (error) throw safeError("wardable", error, "Could not record discharge");

    return row as unknown as WardableStatus;
  });

/** Undo a previously recorded discharge — clears `discharged_at`. */
export const clearDischarge = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ partner_patient_id: z.string().min(1).max(200) }).parse(d),
  )
  .handler(async ({ data, context }): Promise<WardableStatus | null> => {
    const nowIso = new Date().toISOString();
    const { data: row, error } = await context.supabase
      .from("patient_wardable_status")
      .update({ discharged_at: null, updated_by: context.userId, updated_at: nowIso })
      .eq("partner_patient_id", data.partner_patient_id)
      .select(COLS)
      .maybeSingle();
    if (error) throw safeError("wardable", error, "Could not clear discharge");
    return (row ?? null) as unknown as WardableStatus | null;
  });
