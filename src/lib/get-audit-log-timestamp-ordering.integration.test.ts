import { describe, it, expect } from "vitest";
import { runGetAuditLog } from "./admin.functions";

/**
 * Integration test: `getAuditLog` returns event timestamps in a stable,
 * monotonic order for create vs update actions across:
 *
 *   - default sort (created_at desc)
 *   - explicit created_at asc
 *   - action-filtered queries (only create, only update)
 *   - repeat calls with the same filters (byte-identical response)
 *
 * The dataset contains rows whose creates and updates deliberately
 * interleave in time and share close-but-distinct timestamps, so any
 * silent re-ordering — or plaintext leak from the sensitive columns
 * carried on those rows — would trip an assertion.
 */

const CLINICIAN_ID = "44444444-4444-4444-4444-444444444444";
const CRYPTO_SUFFIXES = ["_enc", "_ciphertext", "_nonce", "_hash"];

type Row = {
  id: string;
  user_id: string;
  action: "create" | "update";
  entity: string;
  entity_id: string;
  created_at: string;
  diff: Record<string, unknown>;
};

// Ten rows: creates and updates interleaved chronologically.
// Timestamps are strictly increasing per index — no ties — so ordering
// assertions are exact.
const ROWS: Row[] = [
  { action: "create", ts: "2026-07-11T08:00:00.000Z" },
  { action: "update", ts: "2026-07-11T08:01:00.000Z" },
  { action: "create", ts: "2026-07-11T08:02:00.000Z" },
  { action: "update", ts: "2026-07-11T08:03:00.000Z" },
  { action: "update", ts: "2026-07-11T08:04:00.000Z" },
  { action: "create", ts: "2026-07-11T08:05:00.000Z" },
  { action: "update", ts: "2026-07-11T08:06:00.000Z" },
  { action: "create", ts: "2026-07-11T08:07:00.000Z" },
  { action: "update", ts: "2026-07-11T08:08:00.000Z" },
  { action: "create", ts: "2026-07-11T08:09:00.000Z" },
].map((r, i) => ({
  id: `aaaa0000-0000-0000-0000-${i.toString().padStart(12, "0")}`,
  user_id: CLINICIAN_ID,
  action: r.action as "create" | "update",
  entity: "referral",
  entity_id: `refr0000-0000-0000-0000-${i.toString().padStart(12, "0")}`,
  created_at: r.ts,
  diff:
    r.action === "create"
      ? {
          status: "pending",
          hospital_number: `HN-CREATE-${i}`,
          hospital_number_enc: `cipher-hn-c-${i}`,
          hospital_number_hash: `hash-hn-c-${i}`,
          reason_for_referral: `RR-CREATE-${i}`,
          reason_for_referral_ciphertext: `cipher-rr-c-${i}`,
          patient_initials: `PI-C-${i}`,
        }
      : {
          status: { old: "pending", new: "accepted" },
          hospital_number: { old: `HN-CREATE-${i}`, new: `HN-UPDATE-${i}` },
          hospital_number_enc: { old: `cipher-hn-c-${i}`, new: `cipher-hn-u-${i}` },
          reason_for_referral: { old: `RR-CREATE-${i}`, new: `RR-UPDATE-${i}` },
          reason_for_referral_nonce: { old: `iv-rr-c-${i}`, new: `iv-rr-u-${i}` },
          patient_initials: { old: `PI-C-${i}`, new: `PI-U-${i}` },
        },
}));

const SENSITIVE_MARKERS = (() => {
  const out: string[] = [];
  for (let i = 0; i < ROWS.length; i++) {
    out.push(
      `HN-CREATE-${i}`, `HN-UPDATE-${i}`,
      `cipher-hn-c-${i}`, `cipher-hn-u-${i}`,
      `hash-hn-c-${i}`,
      `RR-CREATE-${i}`, `RR-UPDATE-${i}`,
      `cipher-rr-c-${i}`,
      `iv-rr-c-${i}`, `iv-rr-u-${i}`,
      `PI-C-${i}`, `PI-U-${i}`,
    );
  }
  return out;
})();

function collectKeys(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const v of node) collectKeys(v, out);
    return out;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out.add(k);
      collectKeys(v, out);
    }
  }
  return out;
}

function assertClean(label: string, payload: unknown) {
  const bad = [...collectKeys(payload)].filter((k) =>
    CRYPTO_SUFFIXES.some((s) => k.endsWith(s)),
  );
  expect(bad, `[${label}] crypto-suffix keys leaked`).toEqual([]);
  const s = JSON.stringify(payload);
  for (const m of SENSITIVE_MARKERS) {
    expect(s.includes(m), `[${label}] sensitive marker "${m}" leaked`).toBe(
      false,
    );
  }
}

function makeAdmin(rows: Row[]) {
  function auditChain() {
    const state: {
      entity?: string;
      action?: string;
      sortDesc: boolean;
    } = { sortDesc: true };
    const chain: any = {
      select: () => chain,
      eq: (col: string, val: string) => {
        if (col === "entity") state.entity = val;
        if (col === "action") state.action = val;
        return chain;
      },
      in: () => chain,
      ilike: () => chain,
      gte: () => chain,
      lte: () => chain,
      order: (col: string, opts?: { ascending?: boolean }) => {
        if (col === "created_at") state.sortDesc = !(opts?.ascending ?? false);
        return chain;
      },
      range: async (from: number, to: number) => {
        let filtered = rows.filter(
          (r) =>
            (!state.entity || r.entity === state.entity) &&
            (!state.action || r.action === state.action),
        );
        filtered = [...filtered].sort((a, b) => {
          const cmp = a.created_at.localeCompare(b.created_at);
          if (cmp !== 0) return state.sortDesc ? -cmp : cmp;
          return a.id.localeCompare(b.id);
        });
        return {
          data: filtered.slice(from, to + 1),
          error: null,
          count: filtered.length,
        };
      },
    };
    return chain;
  }
  const empty = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "range" || prop === "limit")
          return async () => ({ data: [], error: null });
        if (prop === "then")
          return (fn: (v: unknown) => unknown) => fn({ data: [], error: null });
        return () => empty;
      },
    },
  ) as any;
  return {
    from: (table: string) => (table === "audit_log" ? auditChain() : empty),
  };
}

function isMonotonic(ts: string[], dir: "asc" | "desc"): boolean {
  for (let i = 1; i < ts.length; i++) {
    const cmp = ts[i - 1].localeCompare(ts[i]);
    if (dir === "asc" && cmp > 0) return false;
    if (dir === "desc" && cmp < 0) return false;
  }
  return true;
}

describe("getAuditLog — stable, ordered timestamps across create/update", () => {
  it("default sort returns all rows newest-first with strictly monotonic timestamps", async () => {
    const admin = makeAdmin(ROWS);
    const page = await runGetAuditLog({ entity: "referral" }, admin);

    expect(page.total).toBe(ROWS.length);
    expect(page.rows).toHaveLength(ROWS.length);

    const ts = page.rows.map((r) => r.created_at);
    expect(isMonotonic(ts, "desc"), `not monotonic desc: ${ts.join(",")}`).toBe(
      true,
    );
    // Newest and oldest are the boundary rows from the fixture.
    expect(ts[0]).toBe("2026-07-11T08:09:00.000Z");
    expect(ts[ts.length - 1]).toBe("2026-07-11T08:00:00.000Z");

    assertClean("default sort", page);
  });

  it("created_at asc returns strictly monotonic ascending timestamps", async () => {
    const admin = makeAdmin(ROWS);
    const page = await runGetAuditLog(
      { entity: "referral", sortBy: "created_at", sortDir: "asc" },
      admin,
    );

    const ts = page.rows.map((r) => r.created_at);
    expect(isMonotonic(ts, "asc"), `not monotonic asc: ${ts.join(",")}`).toBe(
      true,
    );
    expect(ts[0]).toBe("2026-07-11T08:00:00.000Z");
    expect(ts[ts.length - 1]).toBe("2026-07-11T08:09:00.000Z");
    assertClean("asc sort", page);
  });

  it("action=create rows are ordered independently of update rows", async () => {
    const admin = makeAdmin(ROWS);
    const page = await runGetAuditLog(
      { entity: "referral", action: "create" },
      admin,
    );

    const expected = ROWS.filter((r) => r.action === "create")
      .map((r) => r.created_at)
      .sort((a, b) => b.localeCompare(a));
    expect(page.rows.every((r) => r.action === "create")).toBe(true);
    expect(page.rows.map((r) => r.created_at)).toEqual(expected);
    expect(isMonotonic(page.rows.map((r) => r.created_at), "desc")).toBe(true);
    assertClean("create-only", page);
  });

  it("action=update rows are ordered independently of create rows", async () => {
    const admin = makeAdmin(ROWS);
    const page = await runGetAuditLog(
      { entity: "referral", action: "update" },
      admin,
    );

    const expected = ROWS.filter((r) => r.action === "update")
      .map((r) => r.created_at)
      .sort((a, b) => b.localeCompare(a));
    expect(page.rows.every((r) => r.action === "update")).toBe(true);
    expect(page.rows.map((r) => r.created_at)).toEqual(expected);
    expect(isMonotonic(page.rows.map((r) => r.created_at), "desc")).toBe(true);
    assertClean("update-only", page);
  });

  it("repeat calls with identical filters return byte-identical, stable ordering", async () => {
    const admin = makeAdmin(ROWS);
    const filters = {
      entity: "referral",
      sortBy: "created_at" as const,
      sortDir: "desc" as const,
    };
    const [a, b, c] = await Promise.all([
      runGetAuditLog(filters, admin),
      runGetAuditLog(filters, admin),
      runGetAuditLog(filters, admin),
    ]);
    const s = JSON.stringify(a);
    expect(JSON.stringify(b)).toBe(s);
    expect(JSON.stringify(c)).toBe(s);
    assertClean("stable-repeat", a);
  });
});
