import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildBridgeCorsHeaders, jsonResponse, preflight } from "./bridge-cors";

const ORIGINAL_ENV = process.env.BRIDGE_ALLOWED_ORIGINS;

describe("bridge-cors allow-list", () => {
  beforeEach(() => {
    delete process.env.BRIDGE_ALLOWED_ORIGINS;
  });
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.BRIDGE_ALLOWED_ORIGINS;
    else process.env.BRIDGE_ALLOWED_ORIGINS = ORIGINAL_ENV;
  });

  it("falls back to * when BRIDGE_ALLOWED_ORIGINS is unset", () => {
    const h = buildBridgeCorsHeaders("https://any.origin");
    expect(h["Access-Control-Allow-Origin"]).toBe("*");
    expect(h["Vary"]).toBeUndefined();
  });

  it("reflects an allowed origin and sets Vary: Origin", () => {
    process.env.BRIDGE_ALLOWED_ORIGINS =
      "https://bridge.partner.nhs.uk, https://ops.example.com";
    const h = buildBridgeCorsHeaders("https://ops.example.com");
    expect(h["Access-Control-Allow-Origin"]).toBe("https://ops.example.com");
    expect(h["Vary"]).toBe("Origin");
  });

  it("omits Access-Control-Allow-Origin for a disallowed origin", () => {
    process.env.BRIDGE_ALLOWED_ORIGINS = "https://bridge.partner.nhs.uk";
    const h = buildBridgeCorsHeaders("https://evil.example");
    expect(h["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(h["Access-Control-Allow-Methods"]).toContain("POST");
  });

  it("omits Access-Control-Allow-Origin when Origin header is missing", () => {
    process.env.BRIDGE_ALLOWED_ORIGINS = "https://bridge.partner.nhs.uk";
    const h = buildBridgeCorsHeaders(null);
    expect(h["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("preflight(request) reflects the Origin when allowed", () => {
    process.env.BRIDGE_ALLOWED_ORIGINS = "https://bridge.partner.nhs.uk";
    const req = new Request("https://app.example/api/public/bridge/health", {
      method: "OPTIONS",
      headers: { origin: "https://bridge.partner.nhs.uk" },
    });
    const res = preflight(req);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://bridge.partner.nhs.uk",
    );
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("preflight(request) does NOT reflect a disallowed origin", () => {
    process.env.BRIDGE_ALLOWED_ORIGINS = "https://bridge.partner.nhs.uk";
    const req = new Request("https://app.example/api/public/bridge/health", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    const res = preflight(req);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("jsonResponse merges CORS headers and preserves the body/status", async () => {
    process.env.BRIDGE_ALLOWED_ORIGINS = "https://bridge.partner.nhs.uk";
    const req = new Request("https://app.example/api/public/bridge/health", {
      headers: { origin: "https://bridge.partner.nhs.uk" },
    });
    const res = jsonResponse({ ok: true }, { status: 202, request: req });
    expect(res.status).toBe(202);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://bridge.partner.nhs.uk",
    );
    expect(await res.json()).toEqual({ ok: true });
  });
});
