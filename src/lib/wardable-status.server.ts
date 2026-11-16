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
import { createHmac, timingSafeEqual } from "node:crypto";
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
  | "review_invalid"
  | "review_expired"
  | "local_forbidden"
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
  rpc: (
    fn: "set_wardable_desired_state" | "confirm_wardable_reviewed_intent",
    args: { _partner_patient_id: string; _wardable: boolean; _reviewed_revision?: string },
  ) => PromiseLike<{
    data: unknown;
    error: { message?: string; code?: string } | null;
  }>;
};

type LocalRow = {
  partner_patient_id: string;
  wardable: boolean;
  desired_revision: string | null;
  partner_sync_status: string | null;
  partner_synced_revision: string | null;
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
  review_invalid: "That review could not be confirmed — nothing was sent. Review again",
  review_expired: "That review has expired — nothing was sent. Review again",
  local_forbidden: "Your account does not have clinical access — nothing was sent",
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
    .select("partner_patient_id, wardable, desired_revision, partner_sync_status, partner_synced_revision")
    .eq("partner_patient_id", id)
    .maybeSingle();
  if (error) return "error";
  if (!data) return null;
  const row = data as Record<string, unknown>;
  if (typeof row.desired_revision !== "string") return "error";
  if (row.partner_synced_revision != null && typeof row.partner_synced_revision !== "string") return "error";
  return {
    partner_patient_id: String(row.partner_patient_id),
    wardable: row.wardable === true,
    desired_revision: row.desired_revision,
    partner_sync_status: (row.partner_sync_status as string | null) ?? null,
    partner_synced_revision: (row.partner_synced_revision as string | null) ?? null,
  };
}

/** Save an outcome ONLY if `rev` is still the current desired revision. */
async function record(
  db: WardableDb,
  id: string,
  rev: string,
  status: PartnerSyncStatus,
  nowIso: string,
  appliedByHub = false,
): Promise<"recorded" | "moved_on" | "error"> {
  const { data, error } = await db
    .from("patient_wardable_status")
    .update({
      partner_sync_status: status,
      partner_sync_checked_at: nowIso,
      // Decimal strings: PostgREST casts them to bigint losslessly.
      ...(appliedByHub ? { partner_synced_revision: rev } : {}),
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
  appliedByHub = false,
): Promise<PartnerSyncOutcome> {
  const r = await record(db, id, rev, status, nowIso, appliedByHub);
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
  return settle(db, partnerPatientId, rev, res, nowIso());
}

/** Map a fenced Hub reply to the recorded outcome for `rev`. */
async function settle(
  db: WardableDb,
  id: string,
  rev: string,
  res: Awaited<ReturnType<typeof postHubWardable>>,
  nowIso: string,
): Promise<PartnerSyncOutcome> {
  switch (res.kind) {
    case "applied":
    case "already_applied":
      return finish(db, id, rev, "synced", null, nowIso, true);
    case "conflict":
      // Every conflict needs the user to review. target_changed means the
      // Hub DID apply this revision and its value was changed natively
      // after — recorded as applied so a confirmation needs a new revision.
      return finish(db, id, rev, "conflict", res.code, nowIso, res.code === "target_changed");
    case "not_shared":
      return finish(db, id, rev, "not_shared", "not_shared", nowIso);
    case "not_configured":
      return finish(db, id, rev, "not_configured", "not_configured", nowIso);
    case "endpoint_unavailable":
      return finish(db, id, rev, "failed", "endpoint_unavailable", nowIso);
    case "forbidden":
      return finish(db, id, rev, "failed", "forbidden", nowIso);
    case "unavailable":
      return finish(db, id, rev, "failed", "unavailable", nowIso);
    default:
      return finish(db, id, rev, "failed", "invalid", nowIso);
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

export type WardableReviewMode = "resend" | "new_revision";

export type WardableRetryReview = {
  local: { wardable: boolean; desired_revision: string; partner_sync_status: string | null } | null;
  hub:
    | { state: "ok"; wardable: boolean | null }
    | { state: "not_shared" | "unavailable" | "not_configured" | "invalid" };
  /**
   * Present only when this exact review may be confirmed. `token` is signed
   * and binds the user, patient, local desired revision + value and the
   * Hub's updated_at + value that were shown, and expires.
   *  - "resend": the same durable revision is sent again (idempotent).
   *  - "new_revision": the reviewed revision was already applied by the Hub
   *    and the Hub value changed natively since, so confirming records a
   *    NEW durable revision (only if the local revision is still the
   *    reviewed one) and sends that.
   */
  confirm: { token: string; mode: WardableReviewMode; expires_at: string } | null;
};

export type ReviewCaller = { userId: string; actor: HubActor };
export type ReviewDeps = HubDeps & { now?: () => Date; reviewSecret?: string; reviewTtlMs?: number };

type ReviewTokenBody = {
  v: 1;
  /** Signed-in user who saw the review. */
  sub: string;
  /** Canonical patient id. */
  pt: string;
  /** Local desired revision (decimal string) and value shown. */
  lr: string;
  lw: boolean;
  /** Hub updated_at (the CAS sent unchanged) and value shown. */
  hu: string;
  hw: boolean | null;
  m: WardableReviewMode;
  exp: number;
};

export const REVIEW_TTL_MS = 2 * 60_000;
const reviewKey = (secret: string) => `${secret}:wardable-review-confirm:v1`;

export function signReviewToken(body: ReviewTokenBody, secret: string): string {
  const payload = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  const sig = createHmac("sha256", reviewKey(secret)).update(payload).digest().toString("base64url");
  return `${payload}.${sig}`;
}

export function verifyReviewToken(token: unknown, secret: string): ReviewTokenBody | null {
  if (typeof token !== "string" || token.length > 4096 || !secret) return null;
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  const expected = createHmac("sha256", reviewKey(secret)).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const b = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ReviewTokenBody;
    if (
      b?.v !== 1 ||
      typeof b.sub !== "string" ||
      canonicalPatientId(b.pt) !== b.pt ||
      !isDesiredRevision(b.lr) ||
      typeof b.lw !== "boolean" ||
      typeof b.hu !== "string" ||
      !b.hu ||
      !(b.hw === null || typeof b.hw === "boolean") ||
      (b.m !== "resend" && b.m !== "new_revision") ||
      typeof b.exp !== "number"
    ) {
      return null;
    }
    return b;
  } catch {
    return null;
  }
}

/**
 * Review step: what a confirmation would send, next to what the Hub shows.
 * A confirm token is issued only after a successful Hub read.
 */
export async function reviewWardableRetry(
  db: WardableDb,
  partnerPatientId: string,
  caller: ReviewCaller,
  deps: ReviewDeps = {},
): Promise<WardableRetryReview> {
  const canonical = canonicalPatientId(partnerPatientId);
  if (!canonical) return { local: null, hub: { state: "invalid" }, confirm: null };
  partnerPatientId = canonical;
  const local = await readLocal(db, partnerPatientId);
  const rev = local && local !== "error" ? revisionString(local.desired_revision) : null;
  const hub = await fetchHubPatient(partnerPatientId, caller.actor, deps);
  const shownLocal =
    local && local !== "error" && rev
      ? { wardable: local.wardable === true, desired_revision: rev, partner_sync_status: local.partner_sync_status }
      : null;
  const shownHub: WardableRetryReview["hub"] =
    hub.kind === "ok"
      ? { state: "ok", wardable: typeof hub.patient.wardable === "boolean" ? hub.patient.wardable : null }
      : hub.kind === "forbidden" || hub.kind === "not_shared"
        ? { state: "not_shared" }
        : hub.kind === "not_configured"
          ? { state: "not_configured" }
          : hub.kind === "unavailable"
            ? { state: "unavailable" }
            : { state: "invalid" };

  let confirm: WardableRetryReview["confirm"] = null;
  const hubUpdatedAt = hub.kind === "ok" && typeof hub.patient.updated_at === "string" ? hub.patient.updated_at : "";
  if (shownLocal && local && local !== "error" && hub.kind === "ok" && hubUpdatedAt && deps.reviewSecret && caller.userId) {
    const hubWardable = shownHub.state === "ok" ? shownHub.wardable : null;
    // The Hub already applied this revision (synced, or target_changed):
    // re-sending it can never change the Hub again.
    const appliedByHub = local.partner_synced_revision === rev;
    const nothingToSend = appliedByHub && hubWardable === shownLocal.wardable;
    if (!nothingToSend) {
      const mode: WardableReviewMode = appliedByHub ? "new_revision" : "resend";
      const exp = (deps.now ?? (() => new Date()))().getTime() + (deps.reviewTtlMs ?? REVIEW_TTL_MS);
      const token = signReviewToken(
        { v: 1, sub: caller.userId, pt: partnerPatientId, lr: rev!, lw: shownLocal.wardable, hu: hubUpdatedAt, hw: hubWardable, m: mode, exp },
        deps.reviewSecret,
      );
      confirm = { token, mode, expires_at: new Date(exp).toISOString() };
    }
  }
  return { local: shownLocal, hub: shownHub, confirm };
}

/**
 * Confirm exactly what was reviewed. The reviewed Hub updated_at is sent
 * unchanged (no re-read / rebase). A changed local state is refused before
 * any write; a changed Hub state comes back as a Hub conflict.
 */
export async function confirmReviewedWardable(
  userDb: WardableRpcDb,
  syncDb: WardableDb,
  token: unknown,
  caller: ReviewCaller,
  deps: ReviewDeps = {},
): Promise<PartnerSyncOutcome> {
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const nowIso = () => new Date((deps.now ?? (() => new Date()))().getTime()).toISOString();
  const t = verifyReviewToken(token, deps.reviewSecret ?? "");
  if (!t || t.sub !== caller.userId) return outcome("failed", "review_invalid", null);
  if (t.exp <= nowMs) return outcome("pending", "review_expired", null);
  const id = t.pt;

  const local = await readLocal(syncDb, id);
  if (local === "error") return outcome("failed", "read_failed", null);
  const rev = revisionString(local?.desired_revision);
  if (!local || !rev) return outcome("failed", "no_state", null);
  if (rev !== t.lr || local.wardable !== t.lw) return outcome("pending", "changed_since_review", rev);

  let sendRev = t.lr;
  if (t.m === "new_revision") {
    const { data, error } = await userDb.rpc("confirm_wardable_reviewed_intent", {
      _partner_patient_id: id,
      _reviewed_revision: t.lr,
      _wardable: t.lw,
    });
    if (error) {
      if (error.code === "PGRST202" || error.code === "42883") return outcome("failed", "paused_until_release", rev);
      if (error.code === "42501") return outcome("failed", "local_forbidden", rev);
      return outcome("failed", "read_failed", rev);
    }
    const raw = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
    // Zero rows = the local revision moved on between our read and the
    // atomic conditional allocation.
    if (!raw) return outcome("pending", "changed_since_review", rev);
    const row = normalizeWardableRow(raw);
    if (!row || row.partner_patient_id !== id || row.wardable !== t.lw || !(BigInt(row.desired_revision) > BigInt(t.lr))) {
      return outcome("failed", "invalid", rev);
    }
    sendRev = row.desired_revision;
  }

  let res: Awaited<ReturnType<typeof postHubWardable>>;
  try {
    res = await postHubWardable(
      { id, expected_updated_at: t.hu, wardable: t.lw, desired_revision: sendRev },
      caller.actor,
      deps,
    );
  } catch {
    return finish(syncDb, id, sendRev, "failed", "unavailable", nowIso());
  }
  return settle(syncDb, id, sendRev, res, nowIso());
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
