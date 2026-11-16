/**
 * Server-only: wardable → ICU Handover Hub transport.
 *
 * Truthfulness rules:
 *  - The local save and the Hub update are reported SEPARATELY. A Hub
 *    failure never hides behind a successful local toggle.
 *  - Every push uses a FRESH Hub revision (GET /patients?id=) and a partial,
 *    revision-checked patch (mandatory expected_updated_at). No full_name
 *    is sent and nothing comes from the stale local patients mirror.
 *  - The pushed value is always the LATEST local desired state (re-read at
 *    push time), and the outcome is only recorded against the revision that
 *    was pushed — an old retry can never overwrite a newer toggle.
 *  - Discharge timing stamps are local analytics only and are never sent.
 */
import {
  fetchHubPatient,
  patchHubPatient,
  type HubActor,
  type HubDeps,
} from "./hub-client.server";

export type PartnerSyncStatus = "synced" | "failed" | "not_configured" | "conflict" | "not_shared";

export type PartnerSyncOutcome = {
  status: PartnerSyncStatus;
  /** Local desired revision this outcome refers to. */
  revision: number | null;
  message: string;
};

type Res<T> = PromiseLike<{ data: T; error: { message: string } | null }>;
export type WardableDb = { from: (t: "patient_wardable_status") => any };

type LocalRow = {
  partner_patient_id: string;
  wardable: boolean;
  wardable_at: string | null;
  desired_revision: number | null;
};

const MESSAGES: Record<PartnerSyncStatus, string> = {
  synced: "ICU Handover Hub updated",
  failed: "Saved here, but ICU Handover Hub could not be updated",
  not_configured: "Saved here only — the ICU Handover Hub link is not configured",
  conflict: "Saved here, but the patient changed in ICU Handover Hub at the same time — retry to update the Hub",
  not_shared: "Saved here, but this patient is no longer shared by ICU Handover Hub",
};

async function readLocal(db: WardableDb, id: string): Promise<LocalRow | null | "error"> {
  const { data, error } = (await db
    .from("patient_wardable_status")
    .select("partner_patient_id, wardable, wardable_at, desired_revision")
    .eq("partner_patient_id", id)
    .maybeSingle()) as Awaited<Res<LocalRow | null>>;
  if (error) return "error";
  return data;
}

async function record(db: WardableDb, row: LocalRow, status: PartnerSyncStatus, nowIso: string) {
  // Only record against the exact desired state we pushed.
  const rev = row.desired_revision ?? 0;
  await db
    .from("patient_wardable_status")
    .update({
      partner_sync_status: status,
      partner_sync_checked_at: nowIso,
      ...(status === "synced" ? { partner_synced_revision: rev } : {}),
    })
    .eq("partner_patient_id", row.partner_patient_id)
    .eq("desired_revision", rev)
    .eq("wardable", row.wardable);
}

/**
 * Push the latest local wardable state for one patient to the Hub.
 * Retries a single revision conflict with a fresh Hub revision.
 */
export async function syncWardableToHub(
  db: WardableDb,
  partnerPatientId: string,
  actor: HubActor,
  deps: HubDeps & { now?: () => Date } = {},
): Promise<PartnerSyncOutcome> {
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();
  let lastStatus: PartnerSyncStatus = "failed";
  let row: LocalRow | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const local = await readLocal(db, partnerPatientId);
    if (local === "error") {
      return { status: "failed", revision: null, message: "Could not read the saved wardable state — the Hub was not updated" };
    }
    if (!local) return { status: "failed", revision: null, message: "No saved wardable state to send" };
    row = local;
    const rev = local.desired_revision ?? 0;

    const hub = await fetchHubPatient(partnerPatientId, actor, deps);
    if (hub.kind === "not_configured") {
      await record(db, local, "not_configured", nowIso);
      return { status: "not_configured", revision: rev, message: MESSAGES.not_configured };
    }
    if (hub.kind === "not_shared" || hub.kind === "forbidden") {
      await record(db, local, "not_shared", nowIso);
      return { status: "not_shared", revision: rev, message: MESSAGES.not_shared };
    }
    if (hub.kind !== "ok") {
      await record(db, local, "failed", nowIso);
      return { status: "failed", revision: rev, message: MESSAGES.failed };
    }

    if (hub.patient.wardable === local.wardable) {
      await record(db, local, "synced", nowIso);
      return { status: "synced", revision: rev, message: MESSAGES.synced };
    }

    const out = await patchHubPatient(
      partnerPatientId,
      hub.patient.updated_at,
      { wardable: local.wardable, wardable_at: local.wardable ? local.wardable_at : null, wardable_by: actor.id },
      actor,
      deps,
    );
    if (out.kind === "ok") {
      await record(db, local, "synced", nowIso);
      return { status: "synced", revision: rev, message: MESSAGES.synced };
    }
    if (out.kind === "conflict") {
      lastStatus = "conflict";
      continue; // fresh revision + latest local state on the next pass
    }
    const status: PartnerSyncStatus =
      out.kind === "not_shared" || out.kind === "forbidden"
        ? "not_shared"
        : out.kind === "not_configured"
          ? "not_configured"
          : "failed";
    await record(db, local, status, nowIso);
    return { status, revision: rev, message: MESSAGES[status] };
  }
  if (row) await record(db, row, lastStatus, nowIso);
  return { status: lastStatus, revision: row?.desired_revision ?? null, message: MESSAGES[lastStatus] };
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
