import { describe, it, expect, vi } from "vitest";
import { loadPartnerBedBoardForCaller } from "./partner-bed-board.server";

// Synthetic only. fetchImpl is a spy; no network is used.
const ctx = (rpcResult: { data: unknown; error: unknown } | Error) => ({
  userId: "00000000-0000-4000-8000-000000000001",
  supabase: {
    rpc: vi.fn(async () => {
      if (rpcResult instanceof Error) throw rpcResult;
      return rpcResult;
    }),
  },
});

const okFetch = () =>
  vi.fn(async () =>
    new Response(JSON.stringify({ unit: "Synthetic", bed_board: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

const deps = (fetchImpl: ReturnType<typeof okFetch>) => ({
  fetchImpl: fetchImpl as unknown as typeof fetch,
  baseUrl: "https://hub.invalid/bridge",
  secret: "synthetic-secret",
  sleep: async () => {},
  maxAttempts: 1,
});

describe("getPartnerBedBoard server guard", () => {
  it.each([
    ["no clinical role", { data: false, error: null }, 403],
    ["null result", { data: null, error: null }, 403],
    ["rpc error", { data: null, error: { message: "boom" } }, 503],
  ])("denies (%s) before any upstream request", async (_n, rpc, status) => {
    const fetchImpl = okFetch();
    const r = await loadPartnerBedBoardForCaller(ctx(rpc), deps(fetchImpl));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.forbidden).toBe(true);
      expect(r.status).toBe(status);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("denies when the role check throws", async () => {
    const fetchImpl = okFetch();
    const r = await loadPartnerBedBoardForCaller(ctx(new Error("x")), deps(fetchImpl));
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("denies a missing user id without calling the role check or upstream", async () => {
    const fetchImpl = okFetch();
    const c = { ...ctx({ data: true, error: null }), userId: "" };
    const r = await loadPartnerBedBoardForCaller(c, deps(fetchImpl));
    expect(r.ok).toBe(false);
    expect(c.supabase.rpc).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("clinical access → signed HMAC request is made", async () => {
    const fetchImpl = okFetch();
    const c = ctx({ data: true, error: null });
    const r = await loadPartnerBedBoardForCaller(c, deps(fetchImpl));
    expect(c.supabase.rpc).toHaveBeenCalledWith("has_clinical_access", { _user_id: c.userId });
    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hub.invalid/bridge/beds");
    const h = new Headers(init.headers);
    expect(h.get("x-signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(h.get("x-timestamp")).toBeTruthy();
    expect(h.get("x-actor")).toBeTruthy();
  });
});
