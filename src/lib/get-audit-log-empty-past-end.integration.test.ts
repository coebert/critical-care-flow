import { describe, it, expect } from "vitest";
import { runGetAuditLog, type AuditSortColumn } from "./admin.functions";

/**
 * Server-side integration: `getAuditLog` at boundary conditions —
 * genuinely empty result sets and offsets past the last page. Both
 * must return well-formed pages that carry the requested pagination
 * metadata and, critically, contain zero unredacted content even if
 * the mock stream *did* accidentally serve some (belt-and-braces).
 *
 * We drive the extracted `runGetAuditLog` helper (the exact code the
 * server-fn `.handler` invokes after `assertAdmin` succeeds) against
 * a query-mimicking Supabase admin stub that:
 *   - honours `.range(from, to)` slicing over an in-memory dataset,
 *     so past-end offsets legitimately return zero rows;
 *   - can be configured to return the sentinel "safe" empty payload
 *     OR a "hostile" payload that DOES leak plaintext + crypto keys,
 *     to prove `redactAuditDiff` runs unconditionally.
 */

// ---------------------------------------------------------------------
// Fixture: rows loaded with dangerous plaintext + crypto-suffix keys.
// ---------------------------------------------------------------------

type Row = {
  id: string;
  user_id: string;
  action: "create" | "update" | "delete";
  entity: "referral" | "referral_note";
  entity_id: string;
  created_at: string;
  diff: unknown;
};

const USER = "11111111-1111-1111-1111-111111111111";

function dangerousDiff(seed: number): unknown {
  return {
    hospital_number: `H-PLAIN-${seed}`,
    hospital_number_enc: `v1:HN-CIPHER-${seed}`,
    hospital_number_hash: `hn-hash-${seed}`,
    reason_for_referral: { old: `R-OLD-${seed}`, new: `R-NEW-${seed}` },
    reason_for_referral_ciphertext: `rr-cipher-${seed}`,
    reason_for_referral_nonce: `IV-RR-${seed}`,
    body: `NOTE-BODY-${seed}`,
    body_ciphertext: `body-cipher-${seed}`,
    body_nonce: `IV-BODY-${seed}`,
    unknown_future_enc: `v3:FUTURE-${seed}`,
    audit_wrapper: {
      nested_hash: `sha256:UNSEEN-${seed}`,
      allergies: { old: `AL-OLD-${seed}`, new: `AL-NEW-${seed}` },
      patient_initials: `ZZ-${seed}`,
    },
    status: "pending",
  };
}

const DATASET: Row[] = Array.from({ length: 5 }, (_, i) => ({
  id: `row-${i}`,
  user_id: USER,
  action: "create",
  entity: "referral",
  entity_id: `ent-${i}`,
  created_at: new Date(Date.UTC(2026, 6, 11, 10, i)).toISOString(),
  diff: dangerousDiff(i),
}));

const FORBIDDEN_MARKERS: string[] = [];
for (let i = 0; i < DATASET.length; i++) {
  FORBIDDEN_MARKERS.push(
    `H-PLAIN-${i}`,
    `v1:HN-CIPHER-${i}`,
    `hn-hash-${i}`,
    `R-OLD-${i}`,
    `R-NEW-${i}`,
    `rr-cipher-${i}`,
    `IV-RR-${i}`,
    `NOTE-BODY-${i}`,
    `body-cipher-${i}`,
    `IV-BODY-${i}`,
    `v3:FUTURE-${i}`,
    `sha256:UNSEEN-${i}`,
    `AL-OLD-${i}`,
    `AL-NEW-${i}`,
    `ZZ-${i}`,
  );
}

const CRYPTO_SUFFIXES = ["_enc", "_ciphertext", "_nonce", "_hash"];
const SENSITIVE_KEYS = new Set([
  "hospital_number",
  "patient_initials",
  "reason_for_referral",
  "reason_for_bed",
  "past_medical_history",
  "past_surgical_history",
  "social_history",
  "baseline_function",
  "proposed_procedure",
  "body",
  "dnacpr_details",
  "dnacpr_reason",
  "tep_details",
  "allergies",
  "infection_organism",
]);

function findLeaks(node: unknown, path: string[] = []): string[] {
  const leaks: string[] = [];
  if (Array.isArray(node)) {
    node.forEach((v, i) => leaks.push(...findLeaks(v, [...path, String(i)])));
    return leaks;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const here = [...path, key];
      if (CRYPTO_SUFFIXES.some((s) => key.endsWith(s))) {
        leaks.push(`crypto key leaked at ${here.join(".")}`);
        continue;
      }
      if (SENSITIVE_KEYS.has(key)) {
        const isRedactedLeaf = (v: unknown) => v === null || v === "[encrypted]";
        const isRedactedDiff =
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          Object.entries(value as Record<string, unknown>).every(
            ([k, v]) => (k === "old" || k === "new") && isRedactedLeaf(v),
          );
        if (!isRedactedLeaf(value) && !isRedactedDiff) {
          leaks.push(
            `sensitive plaintext leaked at ${here.join(".")}: ${JSON.stringify(value)}`,
          );
        }
        continue;
      }
      leaks.push(...findLeaks(value, here));
    }
  }
  return leaks;
}

function assertClean(where: string, payload: unknown) {
  const leaks = findLeaks(payload);
  expect(
    leaks,
    `[${where}] leaked ${leaks.length} field(s):\n  ${leaks.join("\n  ")}`,
  ).toEqual([]);
  const serialised = JSON.stringify(payload);
  for (const m of FORBIDDEN_MARKERS) {
    expect(
      serialised.includes(m),
      `[${where}] response contained forbidden marker "${m}"`,
    ).toBe(false);
  }
}

// ---------------------------------------------------------------------
// Query-mimicking Supabase admin stub. Applies filters/sort/range
// against `dataset`. Also supports forced empty/error payloads.
// ---------------------------------------------------------------------

type Mode =
  | { kind: "dataset"; rows: Row[] }
  | { kind: "empty-null" } // { data: null, count: 0 }
  | { kind: "empty-array" } // { data: [], count: 0 }
  | { kind: "hostile-past-end"; rows: Row[] }; // dataset served regardless of range

function makeAdmin(mode: Mode) {
  const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];

  function auditBuilder(record: { table: string; ops: Array<[string, unknown[]]> }) {
    const filters: Array<
      | { kind: "eq"; column: string; value: unknown }
      | { kind: "in"; column: string; values: unknown[] }
    > = [];
    const orders: Array<{ column: string; ascending: boolean }> = [];
    const push = (op: string, args: unknown[]) => record.ops.push([op, args]);

    const chain: any = {
      select(cols: string, opts?: unknown) {
        push("select", [cols, opts]);
        return chain;
      },
      order(column: string, o?: { ascending?: boolean }) {
        push("order", [column, o]);
        orders.push({ column, ascending: o?.ascending ?? true });
        return chain;
      },
      eq(column: string, value: unknown) {
        push("eq", [column, value]);
        filters.push({ kind: "eq", column, value });
        return chain;
      },
      in(column: string, values: unknown[]) {
        push("in", [column, values]);
        filters.push({ kind: "in", column, values });
        return chain;
      },
      gte(column: string, value: string) {
        push("gte", [column, value]);
        return chain;
      },
      lte(column: string, value: string) {
        push("lte", [column, value]);
        return chain;
      },
      async range(from: number, to: number) {
        push("range", [from, to]);
        if (mode.kind === "empty-null") {
          return { data: null, error: null, count: 0 };
        }
        if (mode.kind === "empty-array") {
          return { data: [], error: null, count: 0 };
        }
        if (mode.kind === "hostile-past-end") {
          // Ignore range: serve the whole hostile dataset to prove the
          // handler still redacts even if the DB unexpectedly returns
          // rows for a past-end offset.
          return { data: mode.rows, error: null, count: mode.rows.length };
        }
        // dataset mode: honour filters + orders + range
        let rows = mode.rows.filter((r) => {
          for (const f of filters) {
            if (f.kind === "eq" && (r as any)[f.column] !== f.value) return false;
            if (f.kind === "in" && !f.values.includes((r as any)[f.column])) return false;
          }
          return true;
        });
        const total = rows.length;
        for (let i = orders.length - 1; i >= 0; i--) {
          const { column, ascending } = orders[i];
          rows = [...rows].sort((a, b) => {
            const av = (a as any)[column];
            const bv = (b as any)[column];
            if (av < bv) return ascending ? -1 : 1;
            if (av > bv) return ascending ? 1 : -1;
            return 0;
          });
        }
        return { data: rows.slice(from, to + 1), error: null, count: total };
      },
    };
    return chain;
  }

  function simpleBuilder(record: { table: string; ops: Array<[string, unknown[]]> }) {
    const chain: any = {
      select(cols: string) {
        record.ops.push(["select", [cols]]);
        return chain;
      },
      ilike(column: string, pattern: string) {
        record.ops.push(["ilike", [column, pattern]]);
        return chain;
      },
      async limit(n: number) {
        record.ops.push(["limit", [n]]);
        return { data: [], error: null };
      },
    };
    return chain;
  }

  const admin = {
    from(table: string) {
      const record = { table, ops: [] as Array<[string, unknown[]]> };
      calls.push(record);
      if (table === "audit_log") return auditBuilder(record);
      return simpleBuilder(record);
    },
  };
  return { admin, calls };
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe("getAuditLog — empty result sets and past-end offsets stay fully redacted", () => {
  const SORTS: Array<[AuditSortColumn, "asc" | "desc"]> = [
    ["created_at", "desc"],
    ["created_at", "asc"],
    ["action", "asc"],
    ["entity", "desc"],
  ];

  it("empty audit_log (data: []) returns an empty page with correct metadata", async () => {
    for (const [sortBy, sortDir] of SORTS) {
      const { admin } = makeAdmin({ kind: "empty-array" });
      const page = await runGetAuditLog(
        { limit: 10, offset: 0, sortBy, sortDir } as any,
        admin,
      );
      expect(page.rows).toEqual([]);
      expect(page.hasMore).toBe(false);
      expect(page.total).toBe(0);
      expect(page.limit).toBe(10);
      expect(page.offset).toBe(0);
      expect(page.sortBy).toBe(sortBy);
      expect(page.sortDir).toBe(sortDir);
      expect(page.nextOffset).toBe(10);
      assertClean(`empty-array sort=${sortBy}/${sortDir}`, page);
    }
  });

  it("empty audit_log (data: null) is normalised to zero rows without leaking", async () => {
    const { admin } = makeAdmin({ kind: "empty-null" });
    const page = await runGetAuditLog(
      { limit: 25, offset: 0, sortBy: "created_at", sortDir: "desc" } as any,
      admin,
    );
    expect(page.rows).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.total).toBe(0);
    expect(page.limit).toBe(25);
    assertClean("empty-null", page);
  });

  it("clinician filter that resolves to zero users yields an empty page (sentinel id)", async () => {
    // Force profiles lookup to return [] → sentinel zero UUID applied
    // → audit_log dataset has no row for that id → empty page.
    const { admin, calls } = makeAdmin({ kind: "dataset", rows: DATASET });
    const page = await runGetAuditLog(
      { clinician: "Nobody Real", limit: 10, offset: 0 } as any,
      admin,
    );
    expect(calls.some((c) => c.table === "profiles")).toBe(true);
    const audit = calls.find((c) => c.table === "audit_log")!;
    const inOp = audit.ops.find(([m]) => m === "in");
    expect(inOp?.[1][0]).toBe("user_id");
    expect(inOp?.[1][1]).toEqual(["00000000-0000-0000-0000-000000000000"]);
    expect(page.rows).toEqual([]);
    expect(page.hasMore).toBe(false);
    assertClean("clinician-unknown → sentinel", page);
  });

  it("offset past the last page returns zero rows with hasMore=false and correct nextOffset", async () => {
    // DATASET has 5 rows. With limit=10, page 1 (offset=0) returns all 5;
    // page 2 (offset=10) is past the end and must return zero rows.
    const { admin: adminP1 } = makeAdmin({ kind: "dataset", rows: DATASET });
    const p1 = await runGetAuditLog({ limit: 10, offset: 0 } as any, adminP1);
    expect(p1.rows.length).toBe(DATASET.length);
    expect(p1.hasMore).toBe(false);
    assertClean("page 1 (all rows)", p1);

    for (const offset of [10, 25, 100]) {
      const { admin } = makeAdmin({ kind: "dataset", rows: DATASET });
      const page = await runGetAuditLog(
        { limit: 10, offset, sortBy: "created_at", sortDir: "desc" } as any,
        admin,
      );
      expect(page.rows).toEqual([]);
      expect(page.hasMore).toBe(false);
      expect(page.offset).toBe(offset);
      expect(page.nextOffset).toBe(offset + 10);
      // total reflects the actual dataset size, not the current page.
      expect(page.total).toBe(DATASET.length);
      assertClean(`past-end offset=${offset}`, page);
    }
  });

  it("offset just past the last row (offset === total) is empty and clean", async () => {
    const { admin } = makeAdmin({ kind: "dataset", rows: DATASET });
    const page = await runGetAuditLog(
      { limit: 3, offset: DATASET.length } as any,
      admin,
    );
    expect(page.rows).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.offset).toBe(DATASET.length);
    expect(page.total).toBe(DATASET.length);
    assertClean("offset === total", page);
  });

  it("hostile DB that returns rows for a past-end offset is still redacted", async () => {
    // Belt-and-braces: even if the storage layer misbehaves and serves
    // rows past the requested range, redactAuditDiff must run.
    const { admin } = makeAdmin({ kind: "hostile-past-end", rows: DATASET });
    const page = await runGetAuditLog(
      { limit: 10, offset: 9999, sortBy: "created_at", sortDir: "desc" } as any,
      admin,
    );
    // Rows came through regardless (that's the point of this mode).
    expect(page.rows.length).toBeGreaterThan(0);
    assertClean("hostile past-end still redacted", page);
  });
});
