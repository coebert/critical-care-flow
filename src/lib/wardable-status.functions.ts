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

export type PartnerSyncReason =
  | "superseded"
  | "revision_conflict"
  | "intent_conflict"
  | "target_changed"
  | "endpoint_unavailable"
  | "forbidden"
  | "unavailable"
  | "invalid"
  | "newer_local_change"
  | "read_failed"
  | "no_state"
  | "not_configured"
  | "not_shared"
  | "changed_since_review"
  | null;

/** Mirrors PartnerSyncOutcome in wardable-status.server.ts. */
export type PartnerSyncOutcome = {
  status: PartnerSyncStatus | "pending";
  reason: PartnerSyncReason;
  revision: string | null;
  recorded: boolean;
  message: string;
};

export type SetWardableResult = {
  /** The local save succeeded if this is returned. */
  local: WardableStatus;
  /** Separate outcome of updating ICU Handover Hub. */
  partner: PartnerSyncOutcome;
};

export type WardableRetryReview = {
  local: { wardable: boolean; desired_revision: string; partner_sync_status: string | null } | null;
  hub:
    | { state: "ok"; wardable: boolean | null }
    | { state: "not_shared" | "unavailable" | "not_configured" | "invalid" };
};

const COLS =
  "partner_patient_id, wardable, wardable_at, discharged_at, updated_at, desired_revision, partner_sync_status, partner_sync_checked_at, partner_synced_revision";

const idSchema = z.string().uuid();

async function requireClinical(context: { supabase: any; userId: string }) {
  const { data, error } = await context.supabase.rpc("has_clinical_access", { _user_id: context.userId });
  if (error) throw new Error("Permission check failed");
  if (data !== true) throw new Error("forbidden: clinical role required");
}

async function serverDeps(context: { userId: string; claims: unknown }) {
  const [{ actorFor }, { supabaseAdmin }, core] = await Promise.all([
    import("./hub-client.server"),
    import("@/integrations/supabase/client.server"),
    import("./wardable-status.server"),
  ]);
  return { actor: actorFor(context.userId, context.claims as Record<string, unknown>), admin: supabaseAdmin as never, core };
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
 * Toggle wardable. The database allocates the next durable revision and
 * records the actor (auth.uid()); then the LATEST desired state is pushed
 * through the Hub's fenced endpoint. Both outcomes are returned.
 */
export const setWardableStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => setSchema.parse(d))
  .handler(async ({ data, context }): Promise<SetWardableResult> => {
    await requireClinical(context);
    const { actor, admin, core } = await serverDeps(context);
    const r = await core.runSetWardable(context.supabase as never, admin, data, actor);
    if (!r.ok) throw new Error(r.error);
    return { local: r.local as unknown as WardableStatus, partner: r.partner };
  });

/** Show what a retry would send next to what the Hub currently shows. */
export const reviewWardableRetry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ partner_patient_id: idSchema }).parse(d))
  .handler(async ({ data, context }): Promise<WardableRetryReview> => {
    await requireClinical(context);
    const { actor, admin, core } = await serverDeps(context);
    return core.reviewWardableRetry(admin, data.partner_patient_id, actor);
  });

/** Re-send ONLY the reviewed, still-current desired revision. */
export const retryWardableSync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ partner_patient_id: idSchema, reviewed_revision: z.string().regex(/^[1-9]\d{0,18}$/) }).parse(d),
  )
  .handler(async ({ data, context }): Promise<PartnerSyncOutcome> => {
    await requireClinical(context);
    const { actor, admin, core } = await serverDeps(context);
    try {
      return await core.retryReviewedWardable(admin, data.partner_patient_id, data.reviewed_revision, actor);
    } catch {
      return { status: "failed", reason: "unavailable", revision: null, recorded: false, message: "ICU Handover Hub could not be updated" };
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
