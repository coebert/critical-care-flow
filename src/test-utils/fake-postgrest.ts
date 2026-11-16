/**
 * In-memory evaluator for the PostgREST builder chain used by the bridge
 * sync feed: select().lte().gt().eq().or("updated_at.gt.\"T\",and(updated_at.eq.\"T\",id.gt.ID)")
 * .order().order().limit(). Timestamps compare at microsecond precision.
 */
type Row = Record<string, unknown>;

export function tsMicros(v: unknown): bigint {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(String(v));
  if (!m) throw new Error(`fake-postgrest: bad timestamp ${String(v)}`);
  const base = BigInt(Date.parse(`${m[1]}${m[3]}`)) * 1000n;
  return base + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
}

export function fakePostgrest(tables: Record<string, Row[]>) {
  const queries: Array<{ table: string; ops: Array<[string, ...unknown[]]> }> = [];
  const state = { fail: false };
  const from = (table: string) => {
    const ops: Array<[string, ...unknown[]]> = [];
    queries.push({ table, ops });
    const preds: Array<(r: Row) => boolean> = [];
    let limit = Infinity;
    let cols: string[] | null = null;
    const b: any = {
      select: (c: string) => {
        ops.push(["select", c]);
        cols = c.trim() === "*" ? null : c.split(",").map((x) => x.trim());
        return b;
      },
      lte: (k: string, v: string) => (ops.push(["lte", k, v]), preds.push((r) => tsMicros(r[k]) <= tsMicros(v)), b),
      gt: (k: string, v: string) => (ops.push(["gt", k, v]), preds.push((r) => tsMicros(r[k]) > tsMicros(v)), b),
      eq: (k: string, v: unknown) => (ops.push(["eq", k, v]), preds.push((r) => r[k] === v), b),
      is: (k: string, v: unknown) => (ops.push(["is", k, v]), preds.push((r) => (r[k] ?? null) === v), b),
      or: (expr: string) => {
        ops.push(["or", expr]);
        const m = /^updated_at\.gt\."([^"]+)",and\(updated_at\.eq\."([^"]+)",id\.gt\.([0-9a-f-]{36})\)$/.exec(expr);
        if (!m || m[1] !== m[2]) throw new Error(`fake-postgrest: unexpected or() ${expr}`);
        const u = tsMicros(m[1]);
        const id = m[3];
        preds.push((r) => tsMicros(r.updated_at) > u || (tsMicros(r.updated_at) === u && String(r.id) > id));
        return b;
      },
      order: (k: string, o: unknown) => (ops.push(["order", k, o]), b),
      limit: (n: number) => (ops.push(["limit", n]), (limit = n), b),
      then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => {
        if (state.fail) return Promise.resolve({ data: null, error: { code: "XX000", message: "secret row contents" } }).then(ok, err);
        const data = (tables[table] ?? [])
          .filter((r) => preds.every((p) => p(r)))
          .sort((a, c) => {
            const d = tsMicros(a.updated_at) - tsMicros(c.updated_at);
            return d !== 0n ? (d < 0n ? -1 : 1) : String(a.id) < String(c.id) ? -1 : String(a.id) > String(c.id) ? 1 : 0;
          })
          .slice(0, limit)
          .map((r) => (cols ? Object.fromEntries(cols.map((k) => [k, r[k] ?? null])) : { ...r }));
        return Promise.resolve({ data, error: null }).then(ok, err);
      },
    };
    return b;
  };
  return { db: { from }, queries, state, tables };
}
