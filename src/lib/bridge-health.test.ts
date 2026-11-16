/** Health is public: presence flags + contract metadata only, never secret values. */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Route } from "@/routes/api/public/bridge/health";

type H = { options: { server: { handlers: { GET: (a: { request: Request }) => Promise<Response> } } } };
const get = async (url: string) => (await (Route as unknown as H).options.server.handlers.GET({ request: new Request(url) })).json();

afterEach(() => vi.unstubAllEnvs());

describe("bridge health", () => {
  it("reports runtime and the sync contract the Hub expects, without the secret", async () => {
    vi.stubEnv("HANDOVER_API_SECRET", "synthetic-secret-value");
    const body = await get("https://critical-care-flow.lovable.app/api/public/bridge/health");
    expect(body).toMatchObject({
      secret_configured: true,
      runtime: "published",
      contract: { sync_schema_version: 1, max_sync_limit: 500, inbound_writes: "retired" },
    });
    expect(body.contract.sync_paths).toContain("/api/public/bridge/referrals?sync=1");
    expect(JSON.stringify(body)).not.toContain("synthetic-secret-value");
  });

  it("identifies the stable preview URL as preview", async () => {
    const body = await get("https://project--a8eeeba1-1944-4344-93c0-4f9de4184412-dev.lovable.app/api/public/bridge/health");
    expect(body.runtime).toBe("preview");
  });
});
