import { describe, it, expect } from "vitest";
import { runGetAuditLog } from "./admin.functions";

/**
 * Integration test: paginate through an audit_log dataset made of
 * interleaved referral CREATE and UPDATE rows and verify:
 *
 *   1. Every row appears on exactly one page (no duplicates across
 *      pages, no gaps) — the invariant that most commonly breaks when
 *      an UPDATE row is written between page fetches or when the sort
 *      key is not tie-broken deterministically.
 *   2. Pagination fields (`total`, `limit`, `offset`, `hasMore`,
 *      `nextOffset`) stay internally consistent across every page for
 *      both `created_at desc` and `created_at asc`.
 *   3. Every returned row's diff is fully redacted — no crypto-suffix
 *      keys, no sensitive plaintext markers, and every `{ old, new }`
 *      sensitive column redacted to `[encrypted]`.
 */

const REFERRAL_IDS = Array.from(
  { length: 6 },
  (_, i) => `10000000-0000-0000-0000-0000000000${(i + 10).toString().padStart(2, "0")}`,
);
const CLINICIAN_ID = "99999999-9999-9999-9999-999999999999";
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

// Build a deterministic 18-row corpus: 6 referrals, each with a CREATE
// row and two UPDATE rows, interleaved by timestamp so pagination has
// to walk create/update/update/create/update/... boundaries.
function buildCorpus(): Row[] {
  const rows: Row[] = [];
  let seq = 0;
  for (let i = 0; i < REFERRAL_IDS.length; i++) {
    const rid = REFERRAL_IDS[i];
    // CREATE
    rows.push({
      id: `aaaa0000-0000-0000-0000-${(seq++).toString().padStart(12, "0")}`,
      user_id: CLINICIAN_ID,
      action: "create",
      entity: "referral",
      entity_id: rid,
      created_at: `2026-07-11T10:${(i * 3).toString().padStart(2, "0")}:00.000Z`,
      diff: {
        status: "pending",
        hospital_number: `HN-C-${i}`,
        hospital_number_enc: `cipher-c-${i}`,
        hospital_number_hash: `hash-c-${i}`,
        reason_for_referral: `RR-C-${i}`,
        reason_for_referral_ciphertext: `cipher-rr-c-${i}`,
        reason_for_referral_nonce: `iv-rr-c-${i}`,
        patient_initials: `PI-C-${i}`,
      },
    });
    // UPDATE 1
    rows.push({
      id: `bbbb0000-0000-0000-0000-${(seq++).toString().padStart(12, "0")}`,
      user_id: CLINICIAN_ID,
      action: "update",
      entity: "referral",
      entity_id: rid,
      created_at: `2026-07-11T10:${(i * 3 + 1).toString().padStart(2, "0")}:00.000Z`,
      diff: {
        status: { old: "pending", new: "accepted" },
        hospital_number: { old: `HN-C-${i}`, new: `HN-U1-${i}` },
        hospital_number_enc: { old: `cipher-c-${i}`, new: `cipher-u1-${i}` },
        reason_for_referral: { old: `RR-C-${i}`, new: `RR-U1-${i}` },
        reason_for_referral_ciphertext: {
          old: `cipher-rr-c-${i}`,
          new: `cipher-rr-u1-${i}`,
        },
        patient_initials: { old: `PI-C-${i}`, new: `PI-U1-${i}` },
      },
    });
    // UPDATE 2
    rows.push({
      id: `cccc0000-0000-0000-0000-${(seq++).toString().padStart(12, "0")}`,
      user_id: CLINICIAN_ID,
      action: "update",
      entity: "referral",
      entity_id: rid,
      created_at: `2026-07-11T10:${(i * 3 + 2).toString().padStart(2, "0")}:00.000Z`,
      diff: {
        decline_reason: { old: null, new: "capacity_full" },
        reason_for_referral: { old: `RR-U1-${i}`, new: `RR-U2-${i}` },
        reason_for_referral_nonce: { old: `iv-rr-u1-${i}`, new: `iv-rr-u2-${i}` },
        past_medical_history: { old: `PMH-U1-${i}`, new: `PMH-U2-${i}` },
      },
    });
  }
  return rows;
}

const CORPUS = buildCorpus();

// Every sensitive plaintext marker we injected — none may appear in any
// paginated response.
const SENSITIVE_MARKERS = (() => {
  const out: string[] = [];
  for (let i = 0; i < REFERRAL_IDS.length; i++) {
    out.push(
      `HN-C-${i}`, `HN-U1-${i}`,
      `cipher-c-${i}`, `cipher-u1-${i}`,
      `hash-c-${i}`,
      `RR-C-${i}`, `RR-U1-${i}`, `RR-U2-${i}`,
      `cipher-rr-c-${i}`, `cipher-rr-u1-${i}`,
      `iv-rr-c-${i}`, `iv-rr-u1-${i}`, `iv-rr-u2-${i}`,
      `PI-C-${i}`, `PI-U1-${i}`,
      `PMH-U1-${i}`, `PMH-U2-${i}`,
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
  const keys = collectKeys(payload);
  const bad = [...keys].filter((k) => CRYPTO_SUFFIXES.some((s) => k.endsWith(s)));
  expect(bad, `[${label}] crypto-suffix keys leaked`).toEqual([]);
  const serialised = JSON.stringify(payload);
  for (const m of SENSITIVE_MARKERS) {
    expect(
      serialised.includes(m),
      `[${label}] sensitive marker "${m}" leaked`,
    ).toBe(false);
  }
}

// Admin stub that filters by entity/action, sorts by created_at with
// `id` as deterministic tiebreaker, and slices inclusive-range style.
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

async function walkAllPages(
  admin: any,
  sortDir: "asc" | "desc",
  limit: number,
) {
  const seen: string[] = [];
  const seenSet = new Set<string>();
  let offset = 0;
  let total = -1;
  // Bounded loop to guarantee termination.
  for (let guard = 0; guard < 100; guard++) {
    const page = await runGetAuditLog(
      { entity: "referral", sortBy: "created_at", sortDir, limit, offset },
      admin,
    );
    if (total === -1) total = page.total;
    else expect(page.total, "total drifted across pages").toBe(total);
    expect(page.limit).toBe(limit);
    expect(page.offset).toBe(offset);
    expect(page.nextOffset).toBe(offset + limit);
    assertClean(`page@offset=${offset} dir=${sortDir}`, page);

    for (const row of page.rows) {
      expect(
        seenSet.has(row.id),
        `row ${row.id} repeated across pages`,
      ).toBe(false);
      seenSet.add(row.id);
      seen.push(row.id);
    }

    if (!page.hasMore) {
      expect(seen.length).toBe(total);
      return { seen, total };
    }
    offset += limit;
  }
  throw new Error("pagination did not terminate");
}

describe("getAuditLog — interleaved create/update pagination", () => {
  it("walks every row exactly once across pages (created_at desc)", async () => {
    const admin = makeAdmin(CORPUS);
    const { seen, total } = await walkAllPages(admin, "desc", 5);
    expect(total).toBe(CORPUS.length);
    expect(new Set(seen).size).toBe(CORPUS.length);

    // desc walk visits newest first — last id should be the earliest CREATE.
    const sorted = [...CORPUS].sort((a, b) => {
      const cmp = a.created_at.localeCompare(b.created_at);
      return cmp !== 0 ? -cmp : a.id.localeCompare(b.id);
    });
    expect(seen).toEqual(sorted.map((r) => r.id));
  });

  it("walks every row exactly once across pages (created_at asc)", async () => {
    const admin = makeAdmin(CORPUS);
    const { seen, total } = await walkAllPages(admin, "asc", 4);
    expect(total).toBe(CORPUS.length);
    expect(new Set(seen).size).toBe(CORPUS.length);

    const sorted = [...CORPUS].sort((a, b) => {
      const cmp = a.created_at.localeCompare(b.created_at);
      return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
    });
    expect(seen).toEqual(sorted.map((r) => r.id));
  });

  it("each referral contributes exactly 1 create + 2 updates across the full walk", async () => {
    const admin = makeAdmin(CORPUS);
    const { seen } = await walkAllPages(admin, "desc", 7);

    // Rebuild action counts from the corpus keyed by id.
    const byId = new Map(CORPUS.map((r) => [r.id, r]));
    const perReferral = new Map<string, { create: number; update: number }>();
    for (const id of seen) {
      const r = byId.get(id)!;
      const bucket = perReferral.get(r.entity_id) ?? { create: 0, update: 0 };
      bucket[r.action] += 1;
      perReferral.set(r.entity_id, bucket);
    }
    expect(perReferral.size).toBe(REFERRAL_IDS.length);
    for (const rid of REFERRAL_IDS) {
      expect(perReferral.get(rid)).toEqual({ create: 1, update: 2 });
    }
  });

  it("filtering by action=update paginates cleanly with redaction intact", async () => {
    const admin = makeAdmin(CORPUS);
    const expectedUpdates = CORPUS.filter((r) => r.action === "update").length;

    const seen = new Set<string>();
    let offset = 0;
    const limit = 4;
    for (let guard = 0; guard < 20; guard++) {
      const page = await runGetAuditLog(
        {
          entity: "referral",
          action: "update",
          sortBy: "created_at",
          sortDir: "desc",
          limit,
          offset,
        },
        admin,
      );
      expect(page.total).toBe(expectedUpdates);
      assertClean(`update-only offset=${offset}`, page);
      for (const row of page.rows) {
        expect(row.action).toBe("update");
        expect(seen.has(row.id), `duplicate ${row.id}`).toBe(false);
        seen.add(row.id);
      }
      if (!page.hasMore) break;
      offset += limit;
    }
    expect(seen.size).toBe(expectedUpdates);
  });
});
