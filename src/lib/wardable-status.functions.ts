import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";
import { normalizeWardableRow } from "./wardable-revision";

export type PartnerSyncStatus = "synced" | "failed" | "not_configured" | "conflict" | "not_shared";

export type WardableStatus = {
  partner_patient_id: string;
  wardable: boolean;
  wardable_at: string | null;
  /** LOCAL discharge-timing stamp for analytics. Not a Hub discharge. */
  discharged_at: string | null;
  updated_at: string;
  /** Canonical decimal string (bigint in storage; never a JS number). */
  desired_revision: string;
  partner_sync_status: PartnerSyncStatus | "pending" | null;
  partner_sync_checked_at: string | null;
  partner_synced_revision: string | null;
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
  | "paused_until_release"
  | "review_invalid"
  | "review_expired"
  | "local_forbidden"
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
  /** Signed, expiring confirmation for exactly this review (null = cannot confirm). */
  confirm: { token: string; mode: "resend" | "new_revision"; expires_at: string } | null;
};

const COLS =
  "partner_patient_id, wardable, wardable_at, discharged_at, updated_at, desired_revision, partner_sync_status, partner_sync_checked_at, partner_synced_revision";

/** Hub patient ids are canonical lowercase UUID text everywhere. */
const idSchema = z.string().uuid().transform((s) => s.toLowerCase());

/** Revisions are read through the text projection when it exists. */
const VIEW = "patient_wardable_status_v";
const MISSING_RELATION = new Set(["42P01", "PGRST205", "PGRST200"]);

function toStatus(raw: unknown): WardableStatus {
  const row = normalizeWardableRow(raw);
  if (!row) throw new Error("Could not read wardable status safely");
  return row as WardableStatus;
}

async function readStatusRows(supabase: any, id?: string): Promise<WardableStatus[]> {
  const run = (rel: string) => {
    let q = supabase.from(rel).select(COLS);
    if (id) q = q.eq("partner_patient_id", id);
    return q;
  };
  let { data, error } = await run(VIEW);
  if (error && MISSING_RELATION.has(String(error.code))) {
    // Pre-release schema: bigint arrives as a JSON number; normalisation
    // rejects anything that is not a safe integer.
    ({ data, error } = await run("patient_wardable_status"));
  }
  if (error) throw safeError("wardable", error, "Could not load wardable status");
  return ((data ?? []) as unknown[]).map(toStatus);
}

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

/** Key for signing review confirmations (server-only bridge secret). */
async function reviewSecret(): Promise<string> {
  try {
    const { getBridgeSecrets } = await import("./bridge-hmac.server");
    return getBridgeSecrets().current || "";
  } catch {
    return "";
  }
}

export const listWardableStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<WardableStatus[]> => {
    return readStatusRows(context.supabase);
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
    return { local: r.local as WardableStatus, partner: r.partner };
  });

/**
 * Show what a confirmation would send next to what the Hub currently shows,
 * with a signed, expiring token bound to this user, patient, local revision
 * and value, and the Hub's updated_at and value.
 */
export const reviewWardableRetry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ partner_patient_id: idSchema }).parse(d))
  .handler(async ({ data, context }): Promise<WardableRetryReview> => {
    await requireClinical(context);
    const { actor, admin, core } = await serverDeps(context);
    return core.reviewWardableRetry(admin, data.partner_patient_id, { userId: context.userId, actor }, {
      reviewSecret: await reviewSecret(),
    });
  });

const confirmSchema = z.object({ review_token: z.string().min(1).max(4096) });

/**
 * Confirm exactly the reviewed state: the reviewed Hub CAS is sent
 * unchanged; stale local state is refused before any write.
 */
export const retryWardableSync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => confirmSchema.parse(d))
  .handler(async ({ data, context }): Promise<PartnerSyncOutcome> => {
    await requireClinical(context);
    const { actor, admin, core } = await serverDeps(context);
    try {
      return await core.confirmReviewedWardable(
        context.supabase as never,
        admin,
        data.review_token,
        { userId: context.userId, actor },
        { reviewSecret: await reviewSecret() },
      );
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
        .select("partner_patient_id")
        .single();
      if (error || !row) throw safeError("wardable", error, "Could not record discharge time");
      const [fresh] = await readStatusRows(context.supabase, data.partner_patient_id);
      if (!fresh) throw new Error("Could not record discharge time");
      return fresh;
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
      .select("partner_patient_id")
      .single();
    if (error || !row) throw safeError("wardable", error, "Could not record discharge time");
    const [fresh] = await readStatusRows(context.supabase, data.partner_patient_id);
    if (!fresh) throw new Error("Could not record discharge time");
    return fresh;
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
      .select("partner_patient_id")
      .maybeSingle();
    if (error) throw safeError("wardable", error, "Could not clear discharge time");
    if (!row) return null;
    const [fresh] = await readStatusRows(context.supabase, data.partner_patient_id);
    return fresh ?? null;
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
