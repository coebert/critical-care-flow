/**
 * Native referral/note deletion: soft delete only (never a hard DELETE on
 * referrals), and an audit row ONLY when the database confirms a row changed.
 * Runs the real deleteReferral / restoreReferral / deleteNote handlers with a
 * recording fake client. Synthetic ids; no network, no real database.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tanstack/react-start", () => {
  const builder = (): any => {
    const b: any = { middleware: () => b, inputValidator: (v: (d: unknown) => unknown) => ((b.validate = v), b) };
    b.handler = (fn: (a: any) => unknown) => Object.assign((a: any) => fn({ ...a, data: b.validate ? b.validate(a.data) : a.data }), { raw: fn, validate: b.validate });
    return b;
  };
  return { createServerFn: () => builder() };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/crypto.server", () => ({ encryptString: (s: string) => s, decryptString: (s: string) => s, hashHospitalNumber: (s: string) => s }));
vi.mock("./crypto.server", () => ({ encryptString: (s: string) => s, decryptString: (s: string) => s, hashHospitalNumber: (s: string) => s }));
vi.mock("./encrypted-notes.functions", () => ({ computeViaAdminFlow: (a: string, b: string | null) => a !== b }));

const audits: any[] = [];
vi.mock("./server-utils", () => ({
  getAdmin: async () => ({
    from: (table: string) => {
      const b: any = {};
      b.insert = (row: unknown) => (table === "audit_log" && audits.push(row), Promise.resolve({ error: null }));
      for (const m of ["select", "eq"]) b[m] = () => b;
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ count: 2, error: null }).then(ok);
      return b;
    },
  }),
}));

import { deleteReferral, restoreReferral, deleteNote } from "./referrals.functions";

const USER = "11111111-1111-4111-8111-111111111111";
const REF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const NOTE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

type Op = { table: string; kind: string; payload?: unknown; filters: string[]; returning?: string };
function fakeClient(opts: { existing: Record<string, unknown> | null; affected: number; isAdmin?: boolean }) {
  const ops: Op[] = [];
  const client = {
    rpc: async () => ({ data: !!opts.isAdmin, error: null }),
    from: (table: string) => {
      const op: Op = { table, kind: "select", filters: [] };
      ops.push(op);
      const b: any = {};
      b.select = (cols: string) => (op.kind === "select" ? (op.payload = cols) : (op.returning = cols), b);
      b.update = (p: unknown) => ((op.kind = "update"), (op.payload = p), b);
      b.delete = () => ((op.kind = "delete"), b);
      for (const m of ["eq", "is", "not", "gte"]) b[m] = (k: string, v: unknown) => (op.filters.push(`${m}:${k}=${String(v)}`), b);
      b.maybeSingle = async () => ({ data: opts.existing, error: null });
      b.then = (ok: (v: unknown) => unknown) =>
        Promise.resolve({ data: Array.from({ length: opts.affected }, () => ({ id: "x" })), error: null }).then(ok);
      return b;
    },
  };
  return { client, ops };
}
const run = (fn: unknown, data: unknown, client: unknown) => (fn as (a: any) => Promise<unknown>)({ data, context: { supabase: client, userId: USER } });

beforeEach(() => (audits.length = 0));

describe("deleteReferral", () => {
  it("soft-deletes (UPDATE deleted_at/deleted_by on a live row), never a DELETE, and audits once", async () => {
    const { client, ops } = fakeClient({ existing: { id: REF, created_by: USER }, affected: 1 });
    await expect(run(deleteReferral, { id: REF }, client)).resolves.toEqual({ ok: true });
    const writes = ops.filter((o) => o.kind !== "select");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ table: "referrals", kind: "update", returning: "id" });
    expect(Object.keys(writes[0].payload as object).sort()).toEqual(["deleted_at", "deleted_by"]);
    expect((writes[0].payload as any).deleted_by).toBe(USER);
    expect(writes[0].filters).toEqual([`eq:id=${REF}`, "is:deleted_at=null"]);
    expect(ops.some((o) => o.kind === "delete")).toBe(false);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ user_id: USER, action: "delete", entity: "referral", entity_id: REF });
  });

  it("writes NO audit when the database changed nothing (already deleted / access changed)", async () => {
    const { client } = fakeClient({ existing: { id: REF, created_by: USER }, affected: 0 });
    await expect(run(deleteReferral, { id: REF }, client)).rejects.toThrow(/not deleted/);
    expect(audits).toHaveLength(0);
  });

  it("refuses a non-creator non-admin before any write", async () => {
    const { client, ops } = fakeClient({ existing: { id: REF, created_by: "someone-else" }, affected: 1 });
    await expect(run(deleteReferral, { id: REF }, client)).rejects.toThrow(/creator or an admin/);
    expect(ops.filter((o) => o.kind !== "select")).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });
});

describe("restoreReferral", () => {
  const deletedRow = { id: REF, created_by: USER, deleted_at: new Date(Date.now() - 3600_000).toISOString() };
  it("restores and audits when a row changed", async () => {
    const { client } = fakeClient({ existing: deletedRow, affected: 1 });
    await expect(run(restoreReferral, { id: REF }, client)).resolves.toEqual({ ok: true });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "update", entity: "referral", entity_id: REF });
  });
  it("no audit when the restore matched nothing", async () => {
    const { client } = fakeClient({ existing: deletedRow, affected: 0 });
    await expect(run(restoreReferral, { id: REF }, client)).rejects.toThrow(/not restored/);
    expect(audits).toHaveLength(0);
  });
});

describe("deleteNote", () => {
  const note = { id: NOTE, referral_id: REF, author_id: USER, created_at: "2026-11-16T10:00:00Z", body_enc: null };
  it("author delete returns the id and audits with the recipient count", async () => {
    const { client, ops } = fakeClient({ existing: note, affected: 1 });
    await expect(run(deleteNote, { id: NOTE }, client)).resolves.toEqual({ ok: true });
    expect(ops.find((o) => o.kind === "delete")).toMatchObject({ table: "referral_notes", returning: "id" });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "delete", entity: "referral_note", entity_id: NOTE });
    expect(audits[0].diff).toMatchObject({ recipient_count: 2, referral_id: REF });
  });
  it("no audit when the policy filtered the delete to zero rows (e.g. access revoked)", async () => {
    const { client } = fakeClient({ existing: note, affected: 0 });
    await expect(run(deleteNote, { id: NOTE }, client)).rejects.toThrow(/not deleted/);
    expect(audits).toHaveLength(0);
  });
});
