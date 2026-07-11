import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration test for the bridge caller authenticator.
 *
 * Guarantees (Batch A P1 of the security review plan):
 *
 * 1. The public Supabase publishable/anon key is REJECTED — a client-side
 *    caller cannot trigger bridge sync by copying it out of the browser
 *    bundle.
 * 2. The `x-cron-secret` header is REQUIRED for cron-triggered calls; a
 *    missing/empty header rejects without touching the DB.
 * 3. `x-cron-secret` is compared timing-safely against the vault-backed
 *    secret returned by `get_bridge_cron_secret`, and mismatched values of
 *    the same OR different length both reject.
 * 4. `apikey` matching `SUPABASE_SERVICE_ROLE_KEY` is accepted for trusted
 *    server-to-server calls.
 * 5. If the RPC errors, the caller is rejected (fail-closed).
 */

const SERVICE_ROLE = "svc-role-key-value";
const PUBLISHABLE = "publishable-anon-key-value";
const CRON_SECRET = "vault-stored-cron-secret";

const rpcMock = vi.fn();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: (name: string, args?: any) => rpcMock(name, args),
  },
}));

async function loadModule() {
  return await import("./bridge-caller-auth.server");
}

function req(headers: Record<string, string>): Request {
  return new Request("https://example.test/bridge", { headers });
}

beforeEach(() => {
  vi.resetModules();
  rpcMock.mockReset();
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE;
  process.env.SUPABASE_PUBLISHABLE_KEY = PUBLISHABLE;
});

afterEach(() => {
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
});

describe("isBridgeCallerAuthorized", () => {
  it("rejects a caller presenting only the public publishable/anon key", async () => {
    const { isBridgeCallerAuthorized } = await loadModule();
    const ok = await isBridgeCallerAuthorized(
      req({ apikey: PUBLISHABLE }),
    );
    expect(ok).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects a caller with no auth headers at all", async () => {
    const { isBridgeCallerAuthorized } = await loadModule();
    expect(await isBridgeCallerAuthorized(req({}))).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("accepts a caller presenting the service-role key in apikey", async () => {
    const { isBridgeCallerAuthorized } = await loadModule();
    expect(await isBridgeCallerAuthorized(req({ apikey: SERVICE_ROLE }))).toBe(
      true,
    );
    // service-role match must not consult the vault
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("accepts a matching x-cron-secret and consults get_bridge_cron_secret", async () => {
    rpcMock.mockResolvedValue({ data: CRON_SECRET, error: null });
    const { isBridgeCallerAuthorized } = await loadModule();
    const ok = await isBridgeCallerAuthorized(
      req({ "x-cron-secret": CRON_SECRET }),
    );
    expect(ok).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith("get_bridge_cron_secret");
  });

  it("rejects a same-length but mismatched x-cron-secret", async () => {
    rpcMock.mockResolvedValue({ data: CRON_SECRET, error: null });
    const wrongSameLen = "x".repeat(CRON_SECRET.length);
    expect(wrongSameLen.length).toBe(CRON_SECRET.length);
    const { isBridgeCallerAuthorized } = await loadModule();
    expect(
      await isBridgeCallerAuthorized(req({ "x-cron-secret": wrongSameLen })),
    ).toBe(false);
  });

  it("rejects a different-length x-cron-secret without throwing", async () => {
    rpcMock.mockResolvedValue({ data: CRON_SECRET, error: null });
    const { isBridgeCallerAuthorized } = await loadModule();
    expect(await isBridgeCallerAuthorized(req({ "x-cron-secret": "short" }))).toBe(
      false,
    );
  });

  it("rejects when the vault RPC returns an error (fail-closed)", async () => {
    rpcMock.mockResolvedValue({ data: null, error: new Error("vault down") });
    const { isBridgeCallerAuthorized } = await loadModule();
    expect(
      await isBridgeCallerAuthorized(req({ "x-cron-secret": CRON_SECRET })),
    ).toBe(false);
  });

  it("rejects when the vault RPC returns an empty secret", async () => {
    rpcMock.mockResolvedValue({ data: "", error: null });
    const { isBridgeCallerAuthorized } = await loadModule();
    expect(
      await isBridgeCallerAuthorized(req({ "x-cron-secret": CRON_SECRET })),
    ).toBe(false);
  });

  it("rejects when supabaseAdmin.rpc throws", async () => {
    rpcMock.mockImplementation(() => {
      throw new Error("network");
    });
    const { isBridgeCallerAuthorized } = await loadModule();
    expect(
      await isBridgeCallerAuthorized(req({ "x-cron-secret": CRON_SECRET })),
    ).toBe(false);
  });

  it("prefers apikey service-role over an invalid x-cron-secret", async () => {
    rpcMock.mockResolvedValue({ data: CRON_SECRET, error: null });
    const { isBridgeCallerAuthorized } = await loadModule();
    const ok = await isBridgeCallerAuthorized(
      req({ apikey: SERVICE_ROLE, "x-cron-secret": "nope" }),
    );
    expect(ok).toBe(true);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
