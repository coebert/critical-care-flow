/**
 * The retired mirror sync endpoints authenticate the caller, report a
 * truthful retired status, and perform NO mutations and NO Hub calls.
 * Synthetic fakes only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const calls: string[] = [];
const authorized = { value: true };
vi.mock("@/lib/bridge-caller-auth.server", () => ({ isBridgeCallerAuthorized: async () => authorized.value }));
vi.mock("@/integrations/supabase/client.server", () => {
  const builder = (table: string) => {
    const b: any = {};
    for (const m of ["select", "eq", "not", "is", "order", "limit", "in", "lt"]) b[m] = (..._a: unknown[]) => (calls.push(`${table}.${m}`), b);
    for (const m of ["insert", "upsert", "update", "delete"]) b[m] = () => (calls.push(`${table}.${m}`), b);
    b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null, count: 2 }).then(ok);
    return b;
  };
  return { supabaseAdmin: { from: builder, rpc: () => (calls.push("rpc"), Promise.resolve({ data: null, error: null })) } };
});

const capacityCheck = vi.fn(async () => ({ kind: "suppressed", reason: "synthetic" }));
vi.mock("@/lib/nurse-capacity-alerts.server", () => ({ checkAndAlertNurseCapacity: () => capacityCheck() }));

import { Route as SyncRoute } from "@/routes/api/public/bridge/sync";
import { Route as RetryRoute } from "@/routes/api/public/bridge/retry-failed";
import { Route as WorkerRoute } from "@/routes/api/public/hooks/bridge-reconcile-worker";

type H = { options: { server: { handlers: Record<string, (a: { request: Request }) => Promise<Response>> } } };
const call = async (route: unknown, method: "GET" | "POST") => {
  const res = await (route as H).options.server.handlers[method]({
    request: new Request("https://ccc.synthetic.test/x", { method, headers: { "x-cron-secret": "synthetic" } }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const MUTATIONS = /\.(insert|upsert|update|delete)$|^rpc$/;

const fetchSpy = vi.fn(async () => {
  throw new Error("network is not allowed in this test");
});
beforeEach(() => {
  calls.length = 0;
  authorized.value = true;
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

describe("retired mirror sync", () => {
  it.each([
    ["sync GET", SyncRoute, "GET"],
    ["sync POST", SyncRoute, "POST"],
    ["worker POST", WorkerRoute, "POST"],
  ] as const)("%s: unauthenticated callers are rejected", async (_n, route, method) => {
    authorized.value = false;
    expect((await call(route, method)).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it.each([
    ["sync GET", SyncRoute, "GET"],
    ["sync POST", SyncRoute, "POST"],
    ["worker POST", WorkerRoute, "POST"],
  ] as const)("%s: retired status, zero mutations, no Hub fetch, no cursor advance", async (_n, route, method) => {
    const r = await call(route, method);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      mode: "retired",
      mutations: 0,
      status: {
        patients: "source_owned_by_hub",
        placement: "source_owned_by_hub",
        referrals: "hub_pulls_ccc_v1_feed",
        bed_board: "direct_read",
      },
    });
    expect(JSON.stringify(r.body)).not.toMatch(/synced|results|last_pulled_at|last_pushed_at/);
    expect(calls.filter((c) => MUTATIONS.test(c))).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("worker re-evaluates capacity only through the guarded alert path (once per run) and reports the outcome", async () => {
    capacityCheck.mockClear();
    const r = await call(WorkerRoute, "POST");
    expect(capacityCheck).toHaveBeenCalledTimes(1);
    expect(r.body).toMatchObject({ mode: "retired", capacity_check: "suppressed" });
    authorized.value = false;
    await call(WorkerRoute, "POST");
    expect(capacityCheck).toHaveBeenCalledTimes(1); // never for unauthenticated callers
  });

  it("retry-failed reports legacy failures as not applicable (count only) and leaves them in place", async () => {
    const r = await call(RetryRoute, "POST");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mode: "retired", failures: { status: "not_applicable", count: 2, retained: true } });
    expect(calls.filter((c) => MUTATIONS.test(c))).toEqual([]);
    expect(calls.every((c) => c.startsWith("bridge_sync_state."))).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
