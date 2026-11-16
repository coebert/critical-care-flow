import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";

export type PartnerSyncStatus = "synced" | "failed" | "not_configured" | "conflict" | "not_shared";

export type WardableStatus = {
  partner_patient_id: string;
  wardable: boolean;
  wardable_at: string | null;
  /** LOCAL discharge-timing stamp for analytics. Not a Hub discharge. */
  discharged_at: string | null;
  updated_at: string;
  desired_revision: number;
  partner_sync_status: PartnerSyncStatus | "pending" | null;
  partner_sync_checked_at: string | null;
  partner_synced_revision: number | null;
};

export type PartnerSyncOutcome = {
  status: PartnerSyncStatus;
  revision: number | null;
  message: string;
};

export type SetWardableResult = {
  /** The local save always succeeded if this is returned. */
  local: WardableStatus;
  /** Separate outcome of updating ICU Handover Hub. */
  partner: PartnerSyncOutcome;
};

const COLS =
  "partner_patient_id, wardable, wardable_at, discharged_at, updated_at, desired_revision, partner_sync_status, partner_sync_checked_at, partner_synced_revision";

const idSchema = z.string().uuid();

async function requireClinical(context: { supabase: any; userId: string }) {
  const { data, error } = await context.supabase.rpc("has_clinical_access", { _user_id: context.userId });
  if (error) throw new Error("Permission check failed");
  if (data !== true) throw new Error("forbidden: clinical role required");
}

async function pushLatest(context: { supabase: any; userId: string; claims: unknown }, id: string) {
  const [{ syncWardableToHub }, { actorFor }] = await Promise.all([
    import("./wardable-status.server"),
    import("./hub-client.server"),
  ]);
  return syncWardableToHub(context.supabase, id, actorFor(context.userId, context.claims as Record<string, unknown>));
}

export const listWardableStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<WardableStatus[]> => {
    const { data, error } = await context.supabase.from("patient_wardable_status").select(COLS);
    if (error) throw safeError("wardable", error, "Could not load wardable status");
    return (data ?? []) as unknown as WardableStatus[];
  });

const setSchema = z.object({
  partner_patient_id: idSchema,
  wardable: z.boolean(),
});

/**
 * Toggle wardable. Saves locally first (the wardable→discharge timer is
 * owned here), then pushes the LATEST local state to the Hub with a fresh
 * revision. Both outcomes are returned so the UI can say exactly what
 * happened.
 */
export const setWardableStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => setSchema.parse(d))
  .handler(async ({ data, context }): Promise<SetWardableResult> => {
    await requireClinical(context);
    const { data: existing, error: readErr } = await context.supabase
      .from("patient_wardable_status")
      .select("wardable, wardable_at, desired_revision")
      .eq("partner_patient_id", data.partner_patient_id)
      .maybeSingle();
    if (readErr) throw safeError("wardable", readErr, "Could not read wardable status");

    const nowIso = new Date().toISOString();
    const wardable_at = data.wardable
      ? existing?.wardable && existing.wardable_at
        ? existing.wardable_at
        : nowIso
      : null;

    const { data: row, error } = await context.supabase
      .from("patient_wardable_status")
      .upsert(
        {
          partner_patient_id: data.partner_patient_id,
          wardable: data.wardable,
          wardable_at,
          discharged_at: null,
          updated_by: context.userId,
          updated_at: nowIso,
          desired_revision: Number(existing?.desired_revision ?? 0) + 1,
          partner_sync_status: "pending",
        },
        { onConflict: "partner_patient_id" },
      )
      .select(COLS)
      .single();
    if (error) throw safeError("wardable", error, "Could not update wardable status");

    let partner: PartnerSyncOutcome;
    try {
      partner = await pushLatest(context, data.partner_patient_id);
    } catch {
      partner = { status: "failed", revision: null, message: "Saved here, but ICU Handover Hub could not be updated" };
    }
    return { local: row as unknown as WardableStatus, partner };
  });

/** Re-send the CURRENT saved wardable state (never an older value). */
export const retryWardableSync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ partner_patient_id: idSchema }).parse(d))
  .handler(async ({ data, context }): Promise<PartnerSyncOutcome> => {
    await requireClinical(context);
    try {
      return await pushLatest(context, data.partner_patient_id);
    } catch {
      return { status: "failed", revision: null, message: "ICU Handover Hub could not be updated" };
    }
  });

/** Origin of the ICU Handover Hub app, for direct patient links. */
export const getHubAppOrigin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ origin: string | null }> => {
    await requireClinical(context);
    const { hubAppOrigin } = await import("./wardable-status.server");
    return { origin: hubAppOrigin() };
  });

const dischargeSchema = z.object({
  partner_patient_id: idSchema,
  discharged_at: z.string().datetime().optional(),
});

/**
 * Record discharge TIMING for analytics (wardable_at → discharged_at).
 * This is NOT a Hub discharge: it never frees a Hub bed, never changes
 * nursing demand, and is never sent to the Hub. The actual discharge is
 * done in ICU Handover Hub; the bed stays occupied here until the Hub
 * roster shows it free.
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

    if (existing) {
      const { data: row, error } = await context.supabase
        .from("patient_wardable_status")
        .update({ discharged_at: nowIso, updated_by: context.userId })
        .eq("partner_patient_id", data.partner_patient_id)
        .select(COLS)
        .single();
      if (error) throw safeError("wardable", error, "Could not record discharge time");
      return row as unknown as WardableStatus;
    }
    const { data: row, error } = await context.supabase
      .from("patient_wardable_status")
      .insert({
        partner_patient_id: data.partner_patient_id,
        wardable: false,
        wardable_at: null,
        discharged_at: nowIso,
        updated_by: context.userId,
        updated_at: nowIso,
      })
      .select(COLS)
      .single();
    if (error) throw safeError("wardable", error, "Could not record discharge time");
    return row as unknown as WardableStatus;
  });

/** Undo a recorded discharge time — clears the local `discharged_at` stamp. */
export const clearDischarge = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ partner_patient_id: idSchema }).parse(d))
  .handler(async ({ data, context }): Promise<WardableStatus | null> => {
    const { data: row, error } = await context.supabase
      .from("patient_wardable_status")
      .update({ discharged_at: null, updated_by: context.userId })
      .eq("partner_patient_id", data.partner_patient_id)
      .select(COLS)
      .maybeSingle();
    if (error) throw safeError("wardable", error, "Could not clear discharge time");
    return (row ?? null) as unknown as WardableStatus | null;
  });

/**
 * Hub-vs-local wardable mismatch for a patient, reconstructed after reload
 * from the saved sync outcome and — when the Hub roster exposes it — the
 * Hub's actual wardable flag.
 */
export function wardableMismatch(
  local: Pick<WardableStatus, "wardable" | "desired_revision" | "partner_sync_status" | "partner_synced_revision"> | undefined,
  hubWardable: boolean | null | undefined,
): { mismatch: boolean; reason: PartnerSyncStatus | "pending" | "hub_differs" | null } {
  const localWardable = local?.wardable === true;
  if (typeof hubWardable === "boolean") {
    return hubWardable === localWardable
      ? { mismatch: false, reason: null }
      : { mismatch: true, reason: local?.partner_sync_status && local.partner_sync_status !== "synced" ? local.partner_sync_status : "hub_differs" };
  }
  if (!local) return { mismatch: false, reason: null };
  if (local.partner_sync_status === "synced" && local.partner_synced_revision === local.desired_revision) {
    return { mismatch: false, reason: null };
  }
  if (local.partner_sync_status == null) return { mismatch: false, reason: null }; // pre-dates tracking
  return { mismatch: true, reason: local.partner_sync_status };
}
