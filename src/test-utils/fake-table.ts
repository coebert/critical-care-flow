/**
 * Tiny in-memory stand-in for a Supabase table, supporting exactly the
 * builder chains used by the acuity and wardable write paths:
 *   select().eq()…maybeSingle()   insert().select().maybeSingle()
 *   update().eq()…[.select()]     delete().eq()…select()
 * `eq` filters are ANDed. Hooks let tests inject read errors or a
 * concurrent write just before a mutation runs.
 */
type Row = Record<string, unknown>;

export function fakeTable(key: string, initial: Row[] = []) {
  const rows: Row[] = initial.map((r) => ({ ...r }));
  const hooks = {
    readError: false,
    beforeMutation: null as null | (() => void),
    writes: [] as Array<{ op: string; patch?: Row }>,
  };
  const match = (filters: Array<[string, unknown]>) => (r: Row) => filters.every(([k, v]) => r[k] === v);

  function builder(op: "select" | "insert" | "update" | "delete", payload?: Row) {
    const filters: Array<[string, unknown]> = [];
    let returning = op === "select";
    const run = () => {
      if (op === "select") {
        if (hooks.readError) return { data: null, error: { message: "synthetic read failure" } };
        return { data: rows.filter(match(filters)).map((r) => ({ ...r })), error: null };
      }
      hooks.beforeMutation?.();
      hooks.beforeMutation = null;
      if (op === "insert") {
        if (rows.some((r) => r[key] === payload![key])) return { data: null, error: { message: "dup", code: "23505" } };
        rows.push({ ...payload });
        hooks.writes.push({ op, patch: payload });
        return { data: [{ ...payload }], error: null };
      }
      const hit = rows.filter(match(filters));
      if (op === "update") {
        for (const r of hit) Object.assign(r, payload);
        hooks.writes.push({ op, patch: payload });
        return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
      }
      for (const r of hit) rows.splice(rows.indexOf(r), 1);
      hooks.writes.push({ op });
      return { data: returning ? hit : null, error: null };
    };
    const b: any = {
      eq: (k: string, v: unknown) => (filters.push([k, v]), b),
      select: () => ((returning = true), b),
      maybeSingle: async () => {
        const r = run();
        if (r.error) return r;
        const list = (r.data as Row[] | null) ?? [];
        return { data: list[0] ?? null, error: null };
      },
      single: async () => {
        const r = run();
        return r.error ? r : { data: ((r.data as Row[]) ?? [])[0] ?? null, error: null };
      },
      then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, err),
    };
    return b;
  }
  const table = {
    select: () => builder("select"),
    insert: (row: Row) => builder("insert", row),
    update: (patch: Row) => builder("update", patch),
    delete: () => builder("delete"),
  };
  return { rows, hooks, table };
}
