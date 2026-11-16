/**
 * In-memory stand-in for patient_wardable_status + the durable revision
 * counter + set_wardable_desired_state() + patient_wardable_status_v,
 * mirroring drizzle/staged/0003_wardable_revision_fence.sql. Synthetic data.
 *
 * Revisions are stored as BigInt. Reads through the VIEW and the RPC return
 * decimal TEXT (as Postgres ::text does); reads of the base TABLE return a
 * JavaScript number, exactly as PostgREST's JSON bigint would arrive — so a
 * value above 2^53 is visibly rounded. Filters/updates accept the decimal
 * string or number that the caller sends and compare as Postgres would after
 * casting the received value (a rounded number therefore does not match).
 */
type Row = {
  partner_patient_id: string;
  wardable: boolean;
  wardable_at: string | null;
  discharged_at: string | null;
  updated_at: string;
  desired_revision: bigint;
  partner_sync_status: string | null;
  partner_sync_checked_at: string | null;
  partner_synced_revision: bigint | null;
};
const VIEW = "patient_wardable_status_v";
const TABLE = "patient_wardable_status";
const REV_COLS = new Set(["desired_revision", "partner_synced_revision"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres casting a received JSON value into bigint. */
const toBig = (v: unknown): bigint | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return BigInt(v); // the number already IS the rounded value
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  throw new Error(`invalid input syntax for type bigint: ${String(v)}`);
};

export function fakeWardableDb(
  opts: { rpcMissing?: boolean; clinical?: boolean; startCounters?: Record<string, bigint> } = {},
) {
  const rows: Row[] = [];
  const counters = new Map<string, bigint>(Object.entries(opts.startCounters ?? {}));
  const hooks = {
    readError: false,
    beforeMutation: null as null | (() => void),
    writes: [] as Array<{ op: string; rel: string; patch?: Record<string, unknown>; filters: Array<[string, unknown]> }>,
  };
  let clock = Date.parse("2026-11-16T11:00:00.000Z");
  const viewMissing = !!opts.rpcMissing;

  const project = (r: Row, rel: string): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...r };
    for (const k of REV_COLS) {
      const v = r[k as keyof Row] as bigint | null;
      out[k] = v === null ? null : rel === VIEW ? v.toString() : Number(v);
    }
    return out;
  };
  const matches = (filters: Array<[string, unknown]>) => (r: Row) =>
    filters.every(([k, v]) => (REV_COLS.has(k) ? r[k as keyof Row] === toBig(v) : (r as any)[k] === v));

  function builder(rel: string, op: "select" | "insert" | "update", payload?: Record<string, unknown>) {
    const filters: Array<[string, unknown]> = [];
    let returning = op === "select";
    const run = (): { data: unknown; error: { message: string; code?: string } | null } => {
      if (rel === VIEW && viewMissing) return { data: null, error: { code: "42P01", message: "relation does not exist" } };
      if (rel === VIEW && op !== "select") return { data: null, error: { code: "42809", message: "view is read-only" } };
      if (op === "select") {
        if (hooks.readError) return { data: null, error: { message: "synthetic read failure" } };
        return { data: rows.filter(matches(filters)).map((r) => project(r, rel)), error: null };
      }
      hooks.beforeMutation?.();
      hooks.beforeMutation = null;
      hooks.writes.push({ op, rel, patch: payload, filters: [...filters] });
      try {
        if (op === "insert") {
          const id = String(payload!.partner_patient_id);
          if (rows.some((r) => r.partner_patient_id === id)) return { data: null, error: { code: "23505", message: "dup" } };
          const r: Row = {
            partner_patient_id: id,
            wardable: payload!.wardable === true,
            wardable_at: (payload!.wardable_at as string | null) ?? null,
            discharged_at: (payload!.discharged_at as string | null) ?? null,
            updated_at: new Date((clock += 1000)).toISOString(),
            desired_revision: toBig(payload!.desired_revision) ?? 0n,
            partner_sync_status: (payload!.partner_sync_status as string | null) ?? null,
            partner_sync_checked_at: (payload!.partner_sync_checked_at as string | null) ?? null,
            partner_synced_revision: toBig(payload!.partner_synced_revision),
          };
          rows.push(r);
          return { data: [project(r, rel)], error: null };
        }
        const hit = rows.filter(matches(filters));
        for (const r of hit) {
          for (const [k, v] of Object.entries(payload ?? {})) (r as any)[k] = REV_COLS.has(k) ? toBig(v) : v;
          r.updated_at = new Date((clock += 1000)).toISOString();
        }
        return { data: returning ? hit.map((r) => project(r, rel)) : null, error: null };
      } catch (e) {
        return { data: null, error: { code: "22P02", message: (e as Error).message } };
      }
    };
    const b: any = {
      eq: (k: string, v: unknown) => (filters.push([k, v]), b),
      select: () => ((returning = true), b),
      maybeSingle: async () => {
        const r = run();
        if (r.error) return r;
        return { data: ((r.data as unknown[]) ?? [])[0] ?? null, error: null };
      },
      single: async () => {
        const r = run();
        return r.error ? r : { data: ((r.data as unknown[]) ?? [])[0] ?? null, error: null };
      },
      then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, err),
    };
    return b;
  }

  const db = {
    from: (rel: string) => ({
      select: () => builder(rel, "select"),
      insert: (row: Record<string, unknown>) => builder(rel, "insert", row),
      update: (patch: Record<string, unknown>) => builder(rel, "update", patch),
    }),
    rpc: async (fn: string, args: { _partner_patient_id: string; _wardable: boolean }) => {
      if (opts.rpcMissing || fn !== "set_wardable_desired_state") {
        return { data: null, error: { code: "PGRST202", message: "function not found" } };
      }
      if (opts.clinical === false) return { data: null, error: { code: "42501", message: "forbidden" } };
      if (!UUID_RE.test(args._partner_patient_id)) return { data: null, error: { code: "22023", message: "invalid patient id" } };
      const id = args._partner_patient_id.toLowerCase(); // canonical BEFORE any read/write
      const next = (counters.get(id) ?? 0n) + 1n;
      if (next > 9223372036854775807n) return { data: null, error: { code: "22003", message: "bigint out of range" } };
      counters.set(id, next);
      clock += 1000;
      const nowIso = new Date(clock).toISOString();
      const existing = rows.find((r) => r.partner_patient_id === id);
      const r: Row = {
        partner_patient_id: id,
        wardable: args._wardable,
        wardable_at: args._wardable ? (existing?.wardable ? existing.wardable_at : nowIso) : null,
        discharged_at: null,
        updated_at: nowIso,
        desired_revision: next,
        partner_sync_status: "pending",
        partner_sync_checked_at: null,
        partner_synced_revision: existing?.partner_synced_revision ?? null,
      };
      if (existing) Object.assign(existing, r);
      else rows.push(r);
      return { data: [project(r, VIEW)], error: null }; // RPC returns revisions ::text
    },
  };
  const row = (id: string) => {
    const r = rows.find((x) => x.partner_patient_id === id);
    return r ? project(r, VIEW) : undefined;
  };
  return {
    db,
    rows,
    counters,
    hooks,
    /** Current row as the text projection (revisions are decimal strings). */
    row,
    /** Outbox cleanup / overlay deletion: the counter is NOT reset. */
    deleteRow: (id: string) => {
      const i = rows.findIndex((r) => r.partner_patient_id === id);
      if (i >= 0) rows.splice(i, 1);
    },
  };
}
