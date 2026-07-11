import { toInitials } from "./patient-initials";

/**
 * Normalise an incoming bridge record so we never overwrite our stored
 * patient identifier with a full name.
 *
 * The partner app models the patient identifier on the `patients` table as
 * `full_name` (we reuse it as the initials carrier — see `bed-board.tsx`).
 * Bed occupancies and outliers use `patient_initials` directly. On both
 * paths the partner or an older client may still send a real name; we
 * strip it down to initials before writing, and clear the value if
 * nothing letter-shaped remains.
 *
 * The function is pure. It returns the normalised record plus a list of
 * `events` describing every conversion or clear that happened, so the
 * caller can persist an audit trail — see `auditBridgeNormalizationEvents`.
 *
 * This is safe to call on any incoming record — resources without a
 * patient identifier field are passed through untouched (`events` empty).
 */
export type BridgeNormalizationEvent = {
  /** The wire field the raw value came in under. */
  field: "full_name" | "patient_initials";
  /** "converted" = derived initials from a longer string.
   *  "cleared"   = value had no letter-shaped content and was set to null. */
  kind: "converted" | "cleared";
  /** Original wire value. Truncated to 120 chars to keep the audit row small
   *  and avoid persisting large blobs of partner-origin free text. */
  before: string;
  /** Value we actually wrote (null when cleared). */
  after: string | null;
};

export type BridgeNormalizationResult = {
  record: Record<string, unknown>;
  events: BridgeNormalizationEvent[];
};

const MAX_BEFORE_LEN = 120;

function truncateForAudit(value: string): string {
  return value.length > MAX_BEFORE_LEN
    ? `${value.slice(0, MAX_BEFORE_LEN)}…`
    : value;
}

export function normalizeIncomingBridgeRecord(
  key: string,
  record: Record<string, unknown>,
): BridgeNormalizationResult {
  const out = { ...record };
  const events: BridgeNormalizationEvent[] = [];

  const normaliseField = (field: "full_name" | "patient_initials") => {
    if (!(field in out)) return;
    const raw = out[field];
    if (raw == null || raw === "") {
      out[field] = null;
      return;
    }
    if (typeof raw !== "string") return;
    const initials = toInitials(raw);
    const after = initials.length ? initials : null;
    out[field] = after;
    if (raw === after) return;
    events.push({
      field,
      kind: after == null ? "cleared" : "converted",
      before: truncateForAudit(raw),
      after,
    });
  };

  if (key === "patients") {
    // Newer wire format sends `patient_initials`; our local column is
    // `full_name` (reused as the initials carrier). Fold the wire field
    // into `full_name` before normalising, then drop it so it never
    // reaches the DB as an unknown column.
    if ("patient_initials" in out) {
      const pi = out.patient_initials;
      if (
        pi != null &&
        pi !== "" &&
        (out.full_name == null || out.full_name === "")
      ) {
        out.full_name = pi;
      }
      delete out.patient_initials;
    }
    normaliseField("full_name");
  }
  if (key === "bed_occupancies" || key === "bed_outliers") {
    normaliseField("patient_initials");
  }

  return { record: out, events };
}

/**
 * Persist an audit trail describing every full-name → initials conversion
 * (or clear) that just happened on an incoming partner-bridge record.
 *
 * Emits ONE `audit_log` row summarising all events for the record, so
 * downstream tooling can trace partner-origin identifier changes without
 * having to correlate multiple rows. No-ops when `events` is empty.
 *
 * Errors are swallowed and logged — auditing must never block the sync
 * write it describes.
 */
export async function auditBridgeNormalizationEvents(
  admin: {
    from: (table: string) => {
      insert: (row: unknown) => Promise<{ error: unknown }>;
    };
  },
  params: {
    resource: string;
    entityId: string | null;
    actor: unknown;
    source: "bridge_pull" | "bridge_push";
    events: BridgeNormalizationEvent[];
  },
): Promise<void> {
  if (params.events.length === 0) return;
  try {
    const { error } = await admin.from("audit_log").insert({
      user_id: null,
      action: "update",
      entity: "bridge_initials_normalization",
      entity_id: params.entityId,
      diff: {
        source: params.source,
        resource: params.resource,
        actor: params.actor ?? null,
        events: params.events,
      },
    });
    if (error) {
      // eslint-disable-next-line no-console
      console.error("bridge normalization audit failed", error);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("bridge normalization audit threw", err);
  }
}
