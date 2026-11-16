/**
 * Server-only: wardable → ICU Handover Hub transport.
 *
 * Ordering and truthfulness rules:
 *  - Every desired-state change gets a durable, strictly increasing
 *    per-patient revision allocated in the database
 *    (set_wardable_desired_state; counter survives overlay deletion).
 *  - Every push goes through the Hub's fenced POST /patients/wardable with
 *    that revision. The Hub reserves the latest revision and rejects older
 *    ones, so a delayed older push can never overwrite a newer toggle —
 *    local compare-and-set alone could not protect the remote effect.
 *  - Even when the Hub already shows the desired boolean we still call the
 *    endpoint, so the latest revision is reserved/acknowledged and older
 *    in-flight work is fenced.
 *  - No automatic rebase after a 409. Retrying needs the user to review the
 *    latest local desired state against the current Hub value.
 *  - The outcome is saved only if the pushed revision is still the current
 *    local desired revision.
 *  - Local save and Hub update are reported separately. No generic patient
 *    POST fallback; a missing endpoint fails closed.
 *  - Discharge timing stamps are local analytics only and are never sent.
 */
import {
  canonicalPatientId,
  normalizeWardableRow,
  revisionString,
  type WardableRow,
} from "./wardable-revision";
import {
  fetchHubPatient,
  isDesiredRevision,
  postHubWardable,
  type HubActor,
  type HubDeps,
} from "./hub-client.server";

export type PartnerSyncStatus = "synced" | "failed" | "not_configured" | "conflict" | "not_shared";

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
  | null;

export type PartnerSyncOutcome = {
  /** "pending" = a newer local change is now the one being sent. */
  status: PartnerSyncStatus | "pending";
  reason: PartnerSyncReason;
  /** Local desired revision this outcome refers to (decimal string). */
  revision: string | null;
  /** Whether the outcome was saved against that revision. */
  recorded: boolean;
  message: string;
};

/** Lossless read projection (staged 0003): revisions as decimal TEXT. */
export const WARDABLE_VIEW = "patient_wardable_status_v";
export type WardableDb = { from: (t: "patient_wardable_status" | typeof WARDABLE_VIEW) => any };
export type WardableRpcDb = WardableDb & {
  rpc: (fn: "set_wardable_desired_state", args: { _partner_patient_id: string; _wardable: boolean }) => PromiseLike<{
    data: unknown;
    error: { message?: string; code?: string } | null;
  }>;
};

type LocalRow = {
  partner_patient_id: string;
  wardable: boolean;
  desired_revision: string | null;
  partner_sync_status: string | null;
};

const MESSAGE: Record<Exclude<PartnerSyncReason, null> | "synced", string> = {
  synced: "ICU Handover Hub updated",
  superseded: "ICU Handover Hub already has a newer wardable change — review before retrying",
  revision_conflict: "The patient changed in ICU Handover Hub at the same time — review and retry",
  intent_conflict: "ICU Handover Hub holds a different value for this change — review before retrying",
  target_changed: "The wardable value was changed directly in ICU Handover Hub after the last update — review before retrying",
  endpoint_unavailable: "Saved here, but ICU Handover Hub cannot accept wardable updates yet",
  forbidden: "Saved here, but ICU Handover Hub refused the update",
  unavailable: "Saved here, but ICU Handover Hub could not be reached",
  invalid: "Saved here, but ICU Handover Hub gave an unexpected answer",
  newer_local_change: "A newer wardable change is being sent instead",
  read_failed: "Could not read the saved wardable state — the Hub was not updated",
  no_state: "No saved wardable change to send",
  not_configured: "Saved here only — the ICU Handover Hub link is not configured",
  not_shared: "Saved here, but this patient is no longer shared by ICU Handover Hub",
  changed_since_review: "The wardable state changed since you reviewed it — review again",
  paused_until_release: "Saved here only — ICU Handover Hub wardable updates start with the coordinated release",
};

const outcome = (
  status: PartnerSyncOutcome["status"],
  reason: PartnerSyncReason,
  revision: string | null,
  recorded = false,
): PartnerSyncOutcome => ({
  status,
  reason,
  revision,
  recorded,
  message: status === "synced" ? MESSAGE.synced : MESSAGE[(reason ?? "invalid") as Exclude<PartnerSyncReason, null>],
});

export { revisionString, canonicalPatientId, normalizeWardableRow } from "./wardable-revision";
export type { WardableRow } from "./wardable-revision";

async function readLocal(db: WardableDb, id: string): Promise<LocalRow | null | "error"> {
  // Only the text projection is trusted for revisions (no number rounding).
  const { data, error } = await db
    .from(WARDABLE_VIEW)
    .select("partner_patient_id, wardable, desired_revision, partner_sync_status")
    .eq("partner_patient_id", id)
    .maybeSingle();
  if (error) return "error";
  if (!data) return null;
  const row = data as Record<string, unknown>;
  if (typeof row.desired_revision !== "string") return "error";
  return {
    partner_patient_id: String(row.partner_patient_id),
    wardable: row.wardable === true,
    desired_revision: row.desired_revision,
    partner_sync_status: (row.partner_sync_status as string | null) ?? null,
  };
}

/** Save an outcome ONLY if `rev` is still the current desired revision. */
async function record(
  db: WardableDb,
  id: string,
  rev: string,
  status: PartnerSyncStatus,
  nowIso: string,
): Promise<"recorded" | "moved_on" | "error"> {
  const { data, error } = await db
    .from("patient_wardable_status")
    .update({
      partner_sync_status: status,
      partner_sync_checked_at: nowIso,
      // Decimal strings: PostgREST casts them to bigint losslessly.
      ...(status === "synced" ? { partner_synced_revision: rev } : {}),
    })
    .eq("partner_patient_id", id)
    .eq("desired_revision", rev)
    .select("partner_patient_id");
  if (error) return "error";
  return Array.isArray(data) && data.length > 0 ? "recorded" : "moved_on";
}

async function finish(
  db: WardableDb,
  id: string,
  rev: string,
  status: PartnerSyncStatus,
  reason: PartnerSyncReason,
  nowIso: string,
): Promise<PartnerSyncOutcome> {
  const r = await record(db, id, rev, status, nowIso);
  if (r === "moved_on") return outcome("pending", "newer_local_change", rev, false);
  return outcome(status, reason, rev, r === "recorded");
}

/**
 * Push the latest local wardable desired state for one patient through the
 * fenced Hub endpoint. Never retries automatically after a conflict.
 */
export async function syncWardableToHub(
  db: WardableDb,
  partnerPatientId: string,
  actor: HubActor,
  deps: HubDeps & { now?: () => Date } = {},
): Promise<PartnerSyncOutcome> {
  const nowIso = () => (deps.now ?? (() => new Date()))().toISOString();
  const canonical = canonicalPatientId(partnerPatientId);
  if (!canonical) return outcome("failed", "invalid", null);
  partnerPatientId = canonical;
  const local = await readLocal(db, partnerPatientId);
  if (local === "error") return outcome("failed", "read_failed", null);
  const rev = revisionString(local?.desired_revision);
  if (!local || !rev) return outcome("failed", "no_state", null);

  const hub = await fetchHubPatient(partnerPatientId, actor, deps);
  if (hub.kind === "not_configured") return finish(db, partnerPatientId, rev, "not_configured", "not_configured", nowIso());
  if (hub.kind === "not_shared") return finish(db, partnerPatientId, rev, "not_shared", "not_shared", nowIso());
  if (hub.kind === "forbidden") return finish(db, partnerPatientId, rev, "not_shared", "forbidden", nowIso());
  if (hub.kind !== "ok") {
    return finish(db, partnerPatientId, rev, "failed", hub.kind === "unavailable" ? "unavailable" : "invalid", nowIso());
  }

  // Cheap early exit if a newer change was made while we read the Hub; the
  // Hub-side fence still protects us if one lands after this point.
  const again = await readLocal(db, partnerPatientId);
  if (again === "error") return outcome("failed", "read_failed", rev);
  if (!again || revisionString(again.desired_revision) !== rev) return outcome("pending", "newer_local_change", rev);

  // ALWAYS call the fenced endpoint — even if the Hub already shows this
  // boolean — so this revision is reserved and older work is fenced.
  const res = await postHubWardable(
    { id: partnerPatientId, expected_updated_at: hub.patient.updated_at, wardable: local.wardable, desired_revision: rev },
    actor,
    deps,
  );
  switch (res.kind) {
    case "applied":
    case "already_applied":
      return finish(db, partnerPatientId, rev, "synced", null, nowIso());
    case "conflict":
      // Every conflict (incl. target_changed: the Hub's value was changed
      // natively after an applied intent) needs the user to review.
      return finish(db, partnerPatientId, rev, "conflict", res.code, nowIso());
    case "not_shared":
      return finish(db, partnerPatientId, rev, "not_shared", "not_shared", nowIso());
    case "not_configured":
      return finish(db, partnerPatientId, rev, "not_configured", "not_configured", nowIso());
    case "endpoint_unavailable":
      return finish(db, partnerPatientId, rev, "failed", "endpoint_unavailable", nowIso());
    case "forbidden":
      return finish(db, partnerPatientId, rev, "failed", "forbidden", nowIso());
    case "unavailable":
      return finish(db, partnerPatientId, rev, "failed", "unavailable", nowIso());
    default:
      return finish(db, partnerPatientId, rev, "failed", "invalid", nowIso());
  }
}

export type SetWardableCoreResult =
  | { ok: true; local: WardableRow; partner: PartnerSyncOutcome }
  | { ok: false; error: string; code: "unavailable" | "forbidden" | "failed" };

/**
 * Record a new desired state (DB allocates the revision and derives the
 * actor from auth.uid()), then push the latest state through the fence.
 * `userDb` must be the caller's own client; `syncDb` the trusted server
 * client used only to read/record the outbox outcome.
 */
export async function runSetWardable(
  userDb: WardableRpcDb,
  syncDb: WardableDb,
  input: { partner_patient_id: string; wardable: boolean },
  actor: HubActor,
  deps: HubDeps & { now?: () => Date } = {},
): Promise<SetWardableCoreResult> {
  const id = canonicalPatientId(input.partner_patient_id);
  if (!id) return { ok: false, code: "failed", error: "Invalid patient id — nothing was changed" };
  input = { ...input, partner_patient_id: id };
  const { data, error } = await userDb.rpc("set_wardable_desired_state", {
    _partner_patient_id: input.partner_patient_id,
    _wardable: input.wardable,
  });
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") {
      // Revision procedure not applied yet (staged for the coordinated
      // release). Keep the LOCAL wardable timer working, but never push to
      // the Hub without the durable revision fence. The Hub has never seen
      // a revision before then, so nothing here can be reused against it.
      return legacyLocalOnly(userDb, input);
    }
    if (error.code === "42501") return { ok: false, code: "forbidden", error: "forbidden: clinical role required" };
    return { ok: false, code: "failed", error: "Could not save the wardable change — nothing was changed" };
  }
  const raw = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  // The RPC returns revisions as TEXT; a number here means an unexpected
  // (lossy) shape — only safe integers are tolerated.
  const row = normalizeWardableRow(raw);
  if (!row || !revisionString(row.desired_revision) || row.partner_patient_id !== id) {
    return { ok: false, code: "failed", error: "Could not confirm the wardable change was saved" };
  }
  let partner: PartnerSyncOutcome;
  try {
    partner = await syncWardableToHub(syncDb, input.partner_patient_id, actor, deps);
  } catch {
    partner = outcome("failed", "unavailable", revisionString(row.desired_revision));
  }
  return { ok: true, local: row, partner };
}

async function legacyLocalOnly(
  db: WardableDb,
  input: { partner_patient_id: string; wardable: boolean },
): Promise<SetWardableCoreResult> {
  const COLS =
    "partner_patient_id, wardable, wardable_at, discharged_at, updated_at, desired_revision, partner_sync_status, partner_sync_checked_at, partner_synced_revision";
  const { data: existing, error: readErr } = await db
    .from("patient_wardable_status")
    .select(COLS)
    .eq("partner_patient_id", input.partner_patient_id)
    .maybeSingle();
  if (readErr) return { ok: false, code: "failed", error: "Could not save the wardable change — nothing was changed" };
  const nowIso = new Date().toISOString();
  const ex = existing ? normalizeWardableRow(existing) : null;
  // Legacy rows arrive as JSON numbers; refuse anything that may be rounded.
  if (existing && !ex) return { ok: false, code: "failed", error: "Could not save the wardable change — nothing was changed" };
  const current = ex ? BigInt(ex.desired_revision) : 0n;
  const next = (current + 1n).toString();
  const patch = {
    wardable: input.wardable,
    wardable_at: input.wardable ? (ex?.wardable && ex.wardable_at ? ex.wardable_at : nowIso) : null,
    discharged_at: null,
    desired_revision: next,
    partner_sync_status: "failed",
    partner_sync_checked_at: nowIso,
  };
  const q = ex
    ? db
        .from("patient_wardable_status")
        .update(patch)
        .eq("partner_patient_id", input.partner_patient_id)
        .eq("desired_revision", ex.desired_revision)
        .select(COLS)
    : db.from("patient_wardable_status").insert({ partner_patient_id: input.partner_patient_id, ...patch }).select(COLS);
  const { data, error } = await q;
  const row = normalizeWardableRow(Array.isArray(data) ? data[0] : data);
  if (error || !row) return { ok: false, code: "failed", error: "Could not save the wardable change — try again" };
  return { ok: true, local: row, partner: outcome("failed", "paused_until_release", revisionString(row.desired_revision), true) };
}

export type WardableRetryReview = {
  local: { wardable: boolean; desired_revision: string; partner_sync_status: string | null } | null;
  hub:
    | { state: "ok"; wardable: boolean | null }
    | { state: "not_shared" | "unavailable" | "not_configured" | "invalid" };
};

/** What a retry would send, next to what the Hub currently shows. */
export async function reviewWardableRetry(
  db: WardableDb,
  partnerPatientId: string,
  actor: HubActor,
  deps: HubDeps = {},
): Promise<WardableRetryReview> {
  const canonical = canonicalPatientId(partnerPatientId);
  if (!canonical) return { local: null, hub: { state: "invalid" } };
  partnerPatientId = canonical;
  const local = await readLocal(db, partnerPatientId);
  const rev = local && local !== "error" ? revisionString(local.desired_revision) : null;
  const hub = await fetchHubPatient(partnerPatientId, actor, deps);
  return {
    local:
      local && local !== "error" && rev
        ? { wardable: local.wardable === true, desired_revision: rev, partner_sync_status: local.partner_sync_status }
        : null,
    hub:
      hub.kind === "ok"
        ? { state: "ok", wardable: typeof hub.patient.wardable === "boolean" ? hub.patient.wardable : null }
        : hub.kind === "forbidden" || hub.kind === "not_shared"
          ? { state: "not_shared" }
          : hub.kind === "not_configured"
            ? { state: "not_configured" }
            : hub.kind === "unavailable"
              ? { state: "unavailable" }
              : { state: "invalid" },
  };
}

/** Explicit retry: only the revision the user reviewed may be sent. */
export async function retryReviewedWardable(
  db: WardableDb,
  partnerPatientId: string,
  reviewedRevision: string,
  actor: HubActor,
  deps: HubDeps & { now?: () => Date } = {},
): Promise<PartnerSyncOutcome> {
  if (!isDesiredRevision(reviewedRevision)) return outcome("failed", "invalid", null);
  const canonical = canonicalPatientId(partnerPatientId);
  if (!canonical) return outcome("failed", "invalid", null);
  partnerPatientId = canonical;
  const local = await readLocal(db, partnerPatientId);
  if (local === "error") return outcome("failed", "read_failed", null);
  const rev = revisionString(local?.desired_revision);
  if (!local || !rev) return outcome("failed", "no_state", null);
  if (rev !== reviewedRevision) return outcome("pending", "changed_since_review", rev);
  return syncWardableToHub(db, partnerPatientId, actor, deps);
}

/** Public origin of the Hub app (derived from the bridge URL), for links. */
export function hubAppOrigin(): string | null {
  const base = process.env.PARTNER_BRIDGE_URL;
  if (!base) return null;
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
}
