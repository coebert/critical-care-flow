/**
 * Wardable desired-state revisions and patient ids (browser- and
 * server-safe, no I/O).
 *
 * Revisions are Postgres bigint in storage but are ALWAYS carried as
 * canonical decimal strings in this app: JSON numbers above 2^53 are rounded
 * by JavaScript, so a number is only accepted when it is a safe integer
 * (legacy reads) and is never re-stringified after possible rounding.
 */
const REVISION_RE = /^[1-9]\d{0,18}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Largest Postgres bigint; revisions above it cannot exist. */
export const PG_BIGINT_MAX = 9223372036854775807n;

/** Canonical positive decimal bigint string, 1..9223372036854775807 (lossless check). */
export const isDesiredRevision = (v: unknown): v is string =>
  typeof v === "string" && REVISION_RE.test(v) && BigInt(v) <= PG_BIGINT_MAX;

/** Canonical positive revision string, or null (unsafe numbers rejected). */
export function revisionString(v: unknown): string | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v > 0 ? String(v) : null;
  if (typeof v === "string" && isDesiredRevision(v)) return v;
  return null;
}

/** Like revisionString but also accepts 0 ("no change yet"); undefined = unusable. */
export function revisionOrZero(v: unknown): string | undefined {
  if (v === 0 || v === "0") return "0";
  return revisionString(v) ?? undefined;
}

/** Canonical lowercase UUID text for a Hub patient id, or null. */
export function canonicalPatientId(id: unknown): string | null {
  return typeof id === "string" && UUID_RE.test(id) ? id.toLowerCase() : null;
}

export type WardableRow = {
  partner_patient_id: string;
  wardable: boolean;
  wardable_at: string | null;
  /** LOCAL discharge-timing stamp for analytics. Not a Hub discharge. */
  discharged_at: string | null;
  updated_at: string;
  /** Canonical decimal string (bigint in storage). */
  desired_revision: string;
  partner_sync_status: string | null;
  partner_sync_checked_at: string | null;
  /** Canonical decimal string or null. */
  partner_synced_revision: string | null;
};

/**
 * Normalise a wardable row so revisions are canonical decimal strings.
 * Returns null when the id or a revision is missing/unsafe (fail closed).
 */
export function normalizeWardableRow(raw: unknown): WardableRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = canonicalPatientId(r.partner_patient_id);
  const desired = revisionOrZero(r.desired_revision);
  const synced = r.partner_synced_revision == null ? null : revisionOrZero(r.partner_synced_revision);
  if (!id || desired === undefined || synced === undefined) return null;
  return {
    partner_patient_id: id,
    wardable: r.wardable === true,
    wardable_at: (r.wardable_at as string | null) ?? null,
    discharged_at: (r.discharged_at as string | null) ?? null,
    updated_at: String(r.updated_at ?? ""),
    desired_revision: desired,
    partner_sync_status: (r.partner_sync_status as string | null) ?? null,
    partner_sync_checked_at: (r.partner_sync_checked_at as string | null) ?? null,
    partner_synced_revision: synced,
  };
}
