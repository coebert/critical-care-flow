import { describe, it, expect } from "vitest";
import { runGetAuditLog } from "./admin.functions";

/**
 * Integration test: creating and then updating a referral note produces
 * two audit_log rows on `entity=referral_note`. Verify that
 * `getAuditLog` returns the updated row (and the create row) with:
 *
 *   - The note `body` plaintext redacted to `[encrypted]` on both rows,
 *     including the `{ old, new }` diff on the update row.
 *   - Every `_enc`/`_ciphertext`/`_nonce`/`_hash` key stripped.
 *   - No sensitive plaintext marker anywhere in the response.
 *   - Filtering by `entity=referral_note` isolates only note-related
 *     rows and leaves redaction intact.
 */

const NOTE_ID = "77777777-7777-7777-7777-777777777777";
const REFERRAL_ID = "88888888-8888-8888-8888-888888888888";
const AUTHOR_ID = "66666666-6666-6666-6666-666666666666";
const CRYPTO_SUFFIXES = ["_enc", "_ciphertext", "_nonce", "_hash"];

const NOTE_CREATE_BODY = "NOTE-CREATE-PLAINTEXT-clinical-body";
const NOTE_UPDATE_OLD_BODY = "NOTE-OLD-PLAINTEXT-body";
const NOTE_UPDATE_NEW_BODY = "NOTE-NEW-PLAINTEXT-body-with-details";

const SENSITIVE_MARKERS = [
  NOTE_CREATE_BODY,
  NOTE_UPDATE_OLD_BODY,
  NOTE_UPDATE_NEW_BODY,
  "cipher-body-create",
  "iv-body-create",
  "cipher-body-old",
  "cipher-body-new",
  "iv-body-old",
  "iv-body-new",
  "hash-body-create",
  "hash-body-old",
  "hash-body-new",
];

const CREATE_ROW = {
  id: "aaaa1111-1111-1111-1111-aaaaaaaaaaaa",
  user_id: AUTHOR_ID,
  action: "create",
  entity: "referral_note",
  entity_id: NOTE_ID,
  created_at: "2026-07-11T13:00:00.000Z",
  diff: {
    referral_id: REFERRAL_ID,
    body: NOTE_CREATE_BODY,
    body_ciphertext: "cipher-body-create",
    body_nonce: "iv-body-create",
    body_hash: "hash-body-create",
  },
};

const UPDATE_ROW = {
  id: "bbbb2222-2222-2222-2222-bbbbbbbbbbbb",
  user_id: AUTHOR_ID,
  action: "update",
  entity: "referral_note",
  entity_id: NOTE_ID,
  created_at: "2026-07-11T13:15:00.000Z",
  diff: {
    body: { old: NOTE_UPDATE_OLD_BODY, new: NOTE_UPDATE_NEW_BODY },
    body_ciphertext: { old: "cipher-body-old", new: "cipher-body-new" },
    body_nonce: { old: "iv-body-old", new: "iv-body-new" },
    body_hash: { old: "hash-body-old", new: "hash-body-new" },
    edited_at: {
      old: null,
      new: "2026-07-11T13:15:00.000Z",
    },
  },
};

// Unrelated referral audit row — should be filtered OUT when the caller
// scopes to entity=referral_note.
const UNRELATED_REFERRAL_ROW = {
  id: "cccc3333-3333-3333-3333-cccccccccccc",
  user_id: AUTHOR_ID,
  action: "update",
  entity: "referral",
  entity_id: REFERRAL_ID,
  created_at: "2026-07-11T13:20:00.000Z",
  diff: { status: { old: "pending", new: "accepted" } },
};

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
  const serialised = JSON.stringify(payload);
  for (const m of SENSITIVE_MARKERS) {
    expect(
      serialised.includes(m),
      `[${label}] sensitive marker "${m}" leaked`,
    ).toBe(false);
  }
}

function makeAdmin(rows: Array<Record<string, unknown>>) {
  function auditChain() {
    const state: { entity?: string; action?: string; sortDesc: boolean } = {
      sortDesc: true,
    };
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
      order: (_col: string, opts?: { ascending?: boolean }) => {
        state.sortDesc = !(opts?.ascending ?? false);
        return chain;
      },
      range: async (from: number, to: number) => {
        let filtered = rows.filter(
          (r: any) =>
            (!state.entity || r.entity === state.entity) &&
            (!state.action || r.action === state.action),
        );
        filtered = [...filtered].sort((a: any, b: any) =>
          state.sortDesc
            ? b.created_at.localeCompare(a.created_at)
            : a.created_at.localeCompare(b.created_at),
        );
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

describe("getAuditLog — referral_note create + update flow", () => {
  it("returns the updated note row with body redacted and crypto keys stripped", async () => {
    const admin = makeAdmin([CREATE_ROW, UPDATE_ROW, UNRELATED_REFERRAL_ROW]);
    const page = await runGetAuditLog({ entity: "referral_note" }, admin);

    expect(page.total).toBe(2);
    expect(page.rows).toHaveLength(2);
    expect(page.rows.map((r) => r.action)).toEqual(["update", "create"]);
    expect(page.rows.every((r) => r.entity === "referral_note")).toBe(true);
    expect(page.rows.every((r) => r.entity_id === NOTE_ID)).toBe(true);

    const [update, create] = page.rows;

    expect(update.diff).toEqual({
      body: { old: "[encrypted]", new: "[encrypted]" },
      edited_at: { old: null, new: "2026-07-11T13:15:00.000Z" },
    });

    expect(create.diff).toEqual({
      referral_id: REFERRAL_ID,
      body: "[encrypted]",
    });

    assertClean("note create+update page", page);
  });

  it("filtering by action=update returns only the note update row, still redacted", async () => {
    const admin = makeAdmin([CREATE_ROW, UPDATE_ROW, UNRELATED_REFERRAL_ROW]);
    const page = await runGetAuditLog(
      { entity: "referral_note", action: "update" },
      admin,
    );

    expect(page.total).toBe(1);
    expect(page.rows).toHaveLength(1);
    const [row] = page.rows;
    expect(row.action).toBe("update");
    expect(row.entity).toBe("referral_note");
    expect(row.entity_id).toBe(NOTE_ID);

    expect(row.diff).toEqual({
      body: { old: "[encrypted]", new: "[encrypted]" },
      edited_at: { old: null, new: "2026-07-11T13:15:00.000Z" },
    });

    assertClean("note update-only page", page);
  });

  it("entity=referral_note filter excludes unrelated referral rows", async () => {
    const admin = makeAdmin([CREATE_ROW, UPDATE_ROW, UNRELATED_REFERRAL_ROW]);
    const page = await runGetAuditLog({ entity: "referral_note" }, admin);

    expect(page.rows.some((r) => r.id === UNRELATED_REFERRAL_ROW.id)).toBe(
      false,
    );
    expect(page.rows.every((r) => r.entity === "referral_note")).toBe(true);
  });
});
