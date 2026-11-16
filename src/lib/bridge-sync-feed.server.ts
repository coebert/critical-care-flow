/**
 * Server-only: versioned, paginated sync feed for the CCC bridge GET routes
 * (`?sync=1`). Default GET behaviour of those routes is unchanged.
 *
 * Envelope (schema_version 1):
 *   { records, schema_version: 1, snapshot_at, pagination: { next_cursor, complete } }
 *
 * Paging: stable ascending (updated_at, id) under a fixed upper fence
 * `updated_at <= snapshot_at`, fetching limit+1 rows. The cursor is
 * server-issued, HMAC-signed and opaque; it carries the resource, the
 * snapshot fence, the filters, and the last (updated_at, id). Every value
 * placed into a filter has been validated against a strict pattern (ISO
 * timestamp / UUID / enum) — no caller text reaches the query grammar.
 *
 * Errors never echo database messages or record contents.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SYNC_SCHEMA_VERSION = 1;
export const DEFAULT_SYNC_LIMIT = 200;
export const MAX_SYNC_LIMIT = 500;

export type SyncResource = "patients" | "investigations" | "referrals" | "microbiology";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Postgres/PostgREST timestamptz text, up to microseconds.
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const PATIENT_STATUSES = ["referred", "admitted", "discharged", "died"] as const;
const REFERRAL_STATUSES = ["pending", "accepted", "declined", "admitted"] as const;

export const isSyncTimestamp = (v: unknown): v is string =>
  typeof v === "string" && TS_RE.test(v) && Number.isFinite(Date.parse(v));

export const PATIENT_SYNC_COLUMNS = [
  "id", "full_name", "hospital_number", "nhs_number", "dob", "location_type", "ward", "bed", "status",
  "admission_date", "discharge_date", "discharge_destination", "date_of_death", "past_medical_history",
  "current_admission", "current_management", "outstanding_tasks", "tep_in_place", "tep_details",
  "dnacpr_decision", "dnacpr_details", "dnacpr_date", "nok_name", "nok_relationship", "nok_contact",
  "nok_last_updated", "nok_last_updated_by", "airway_type", "created_at", "updated_at",
] as const;
export const INVESTIGATION_SYNC_COLUMNS = ["id", "patient_id", "category", "findings", "result_at", "created_at", "updated_at"] as const;
export const MICROBIOLOGY_SOURCE_COLUMNS = [
  "id", "patient_id", "organism", "sample_type", "sensitivities", "sampled_at", "reported_at", "notes", "created_at", "updated_at",
] as const;

type Filters = Record<string, string>;
type CursorBody = { v: 1; r: SyncResource; s: string; u: string | null; i: string | null; f: Filters };

export type SyncDb = { from: (table: string) => any };

export type SyncRequestDeps = {
  db: SyncDb;
  secret: string;
  now?: () => Date;
  log?: (msg: string, meta: Record<string, unknown>) => void;
};

export type SyncResponse = { status: number; body: Record<string, unknown> };

const bad = (error: string, status = 400): SyncResponse => ({ status, body: { error, schema_version: SYNC_SCHEMA_VERSION } });

const cursorKey = (secret: string) => `${secret}:bridge-sync-cursor:v1`;

export function encodeCursor(body: CursorBody, secret: string): string {
  const payload = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  const sig = createHmac("sha256", cursorKey(secret)).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function decodeCursor(raw: string, secret: string, resource: SyncResource): CursorBody | null {
  if (raw.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(raw)) return null;
  const [payload, sig] = raw.split(".");
  const expected = createHmac("sha256", cursorKey(secret)).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let body: CursorBody;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!body || body.v !== 1 || body.r !== resource || !isSyncTimestamp(body.s)) return null;
  if ((body.u === null) !== (body.i === null)) return null;
  if (body.u !== null && (!isSyncTimestamp(body.u) || !UUID_RE.test(String(body.i)))) return null;
  if (!body.f || typeof body.f !== "object") return null;
  return body;
}

function parseFilters(resource: SyncResource, url: URL): Filters | string {
  const f: Filters = {};
  const since = url.searchParams.get("since");
  if (since !== null) {
    if (!isSyncTimestamp(since)) return "invalid_since";
    f.since = since;
  }
  if (resource === "patients" || resource === "referrals") {
    const status = url.searchParams.get("status");
    if (status !== null) {
      const allowed: readonly string[] = resource === "patients" ? PATIENT_STATUSES : REFERRAL_STATUSES;
      if (!allowed.includes(status)) return "invalid_status";
      f.status = status;
    }
  }
  if (resource === "investigations" || resource === "microbiology") {
    const pid = url.searchParams.get("patient_id");
    if (pid !== null) {
      if (!UUID_RE.test(pid)) return "invalid_patient_id";
      f.patient_id = pid;
    }
  }
  return f;
}

const sameFilters = (a: Filters, b: Filters) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

function parseLimit(url: URL): number | null {
  const raw = url.searchParams.get("limit");
  if (raw === null) return DEFAULT_SYNC_LIMIT;
  if (!/^\d{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_SYNC_LIMIT ? n : null;
}

// ---- per-resource record mapping -----------------------------------------

type MapResult = { ok: true; record: Record<string, unknown> } | { ok: false; id: string; missing: string[] };

const nonBlank = (v: unknown) => typeof v === "string" && v.trim() !== "";

export function mapMicrobiologyV1(row: Record<string, unknown>): MapResult {
  const missing: string[] = [];
  for (const k of ["id", "patient_id", "created_at", "updated_at"]) if (!nonBlank(row[k])) missing.push(k);
  if (!nonBlank(row.sample_type)) missing.push("sample_type");
  if (!nonBlank(row.reported_at)) missing.push("reported_at");
  if (!nonBlank(row.organism)) missing.push("organism");
  if (row.sensitivities === undefined || row.sensitivities === null) missing.push("sensitivities");
  if (missing.length) return { ok: false, id: String(row.id ?? ""), missing };
  const lines = [
    "Imported from Critical Care Connect microbiology record (original fields, no interpretation).",
    `Organism: ${String(row.organism)}`,
    `Sensitivities (original): ${JSON.stringify(row.sensitivities)}`,
  ];
  if (nonBlank(row.notes)) lines.push(`Notes: ${String(row.notes)}`);
  if (nonBlank(row.sampled_at)) lines.push(`Sampled at: ${String(row.sampled_at)}`);
  return {
    ok: true,
    record: {
      id: row.id,
      patient_id: row.patient_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      mapping: "ccc.microbiology.v1",
      imported_from: "critical_care_connect",
      specimen_type: String(row.sample_type),
      result_at: row.reported_at,
      findings: lines.join("\n"),
    },
  };
}

function mapReferral(row: Record<string, unknown>, readColumns: readonly string[]): MapResult {
  if (row.deleted_at) {
    // Tombstone: identifiers and ciphertext never included.
    return { ok: true, record: { id: row.id, updated_at: row.updated_at, deleted_at: row.deleted_at } };
  }
  const out: Record<string, unknown> = {};
  for (const k of readColumns) if (k !== "deleted_at") out[k] = row[k];
  return { ok: true, record: out };
}

export type ResourceConfig = {
  table: string;
  select: string;
  map: (row: Record<string, unknown>) => MapResult;
  /** Restrict to non-deleted rows (all but referrals). */
  baseFilter?: (q: any) => any;
};

export function referralResourceConfig(readColumns: readonly string[]): ResourceConfig {
  const cols = Array.from(new Set([...readColumns, "created_at", "updated_at", "deleted_at"]));
  return { table: "referrals", select: cols.join(","), map: (r) => mapReferral(r, cols) };
}

const plain = (cols: readonly string[]) => (row: Record<string, unknown>): MapResult => {
  const out: Record<string, unknown> = {};
  for (const k of cols) out[k] = row[k];
  return { ok: true, record: out };
};

export const RESOURCE_CONFIG: Record<Exclude<SyncResource, "referrals">, ResourceConfig> = {
  patients: { table: "patients", select: PATIENT_SYNC_COLUMNS.join(","), map: plain(PATIENT_SYNC_COLUMNS) },
  investigations: { table: "investigations", select: INVESTIGATION_SYNC_COLUMNS.join(","), map: plain(INVESTIGATION_SYNC_COLUMNS) },
  microbiology: { table: "microbiology", select: MICROBIOLOGY_SOURCE_COLUMNS.join(","), map: mapMicrobiologyV1 },
};

/**
 * Serve one page of the versioned sync feed. `url` is the full request URL
 * (already HMAC-verified by the caller).
 */
export async function serveSyncPage(
  resource: SyncResource,
  config: ResourceConfig,
  url: URL,
  deps: SyncRequestDeps,
): Promise<SyncResponse> {
  const log = deps.log ?? ((m, meta) => console.warn(m, meta));
  if (!deps.secret) return bad("sync_not_configured", 500);
  const limit = parseLimit(url);
  if (limit === null) return bad("invalid_limit");
  const filters = parseFilters(resource, url);
  if (typeof filters === "string") return bad(filters);

  let snapshotAt: string;
  let after: { u: string; i: string } | null = null;
  let activeFilters: Filters = filters;
  const rawCursor = url.searchParams.get("cursor");
  if (rawCursor !== null) {
    const c = decodeCursor(rawCursor, deps.secret, resource);
    if (!c) return bad("invalid_cursor");
    // A cursor continues the SAME snapshot with the SAME filters.
    if (Object.keys(filters).length > 0 && !sameFilters(filters, c.f)) return bad("cursor_filter_mismatch");
    snapshotAt = c.s;
    activeFilters = c.f;
    after = c.u && c.i ? { u: c.u, i: c.i } : null;
  } else {
    snapshotAt = (deps.now ?? (() => new Date()))().toISOString();
  }

  let q = deps.db.from(config.table).select(config.select).lte("updated_at", snapshotAt);
  if (activeFilters.since) q = q.gt("updated_at", activeFilters.since);
  if (activeFilters.status) q = q.eq("status", activeFilters.status);
  if (activeFilters.patient_id) q = q.eq("patient_id", activeFilters.patient_id);
  if (after) {
    // Values are validated ISO timestamp / UUID; quoted for PostgREST.
    q = q.or(`updated_at.gt."${after.u}",and(updated_at.eq."${after.u}",id.gt.${after.i})`);
  }
  q = q.order("updated_at", { ascending: true }).order("id", { ascending: true }).limit(limit + 1);

  const { data, error } = (await q) as { data: Record<string, unknown>[] | null; error: { code?: string } | null };
  if (error || !Array.isArray(data)) {
    log("[bridge-sync] query failed", { resource, code: error?.code ?? "no_data" });
    return bad("query_failed", 500);
  }

  const hasMore = data.length > limit;
  const page = hasMore ? data.slice(0, limit) : data;
  const records: Record<string, unknown>[] = [];
  const invalid: Array<{ id: string; missing: string[] }> = [];
  for (const row of page) {
    const m = config.map(row);
    if (m.ok) records.push(m.record);
    else invalid.push({ id: m.id, missing: m.missing });
  }
  if (invalid.length) {
    log("[bridge-sync] incomplete source records", { resource, count: invalid.length });
    return {
      status: 422,
      body: {
        error: "incomplete_source_records",
        schema_version: SYNC_SCHEMA_VERSION,
        snapshot_at: snapshotAt,
        invalid,
      },
    };
  }

  let nextCursor: string | null = null;
  if (hasMore) {
    const last = page[page.length - 1];
    const u = String(last.updated_at);
    const i = String(last.id);
    if (!isSyncTimestamp(u) || !UUID_RE.test(i)) {
      log("[bridge-sync] unpageable row", { resource });
      return bad("query_failed", 500);
    }
    nextCursor = encodeCursor({ v: 1, r: resource, s: snapshotAt, u, i, f: activeFilters }, deps.secret);
  }
  return {
    status: 200,
    body: {
      records,
      schema_version: SYNC_SCHEMA_VERSION,
      snapshot_at: snapshotAt,
      pagination: { next_cursor: nextCursor, complete: !hasMore },
    },
  };
}

/** Route glue: verified request → JSON response for `?sync=1`. */
export async function handleSyncGet(
  resource: SyncResource,
  config: ResourceConfig,
  request: Request,
  jsonResponse: (b: unknown, init?: ResponseInit) => Response,
): Promise<Response> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  let secret = "";
  try {
    const { getBridgeSecrets } = await import("./bridge-hmac.server");
    secret = getBridgeSecrets().current;
  } catch {
    secret = "";
  }
  const r = await serveSyncPage(resource, config, new URL(request.url), { db: supabaseAdmin as unknown as SyncDb, secret });
  return jsonResponse(r.body, { status: r.status });
}
