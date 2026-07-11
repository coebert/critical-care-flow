import { describe, expect, it } from "vitest";

import { SECURITY_HEADERS, withSecurityHeaders } from "./security-headers.server";

describe("withSecurityHeaders", () => {
  it("adds every security header to a plain response", () => {
    const wrapped = withSecurityHeaders(new Response("ok"));
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      expect(wrapped.headers.get(key)).toBe(value);
    }
  });

  it("preserves status, statusText, and body", async () => {
    const wrapped = withSecurityHeaders(
      new Response("hello", { status: 201, statusText: "Created" }),
    );
    expect(wrapped.status).toBe(201);
    expect(wrapped.statusText).toBe("Created");
    expect(await wrapped.text()).toBe("hello");
  });

  it("does not overwrite headers the handler already set", () => {
    const original = new Response(null, {
      headers: {
        "X-Frame-Options": "SAMEORIGIN",
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
    });
    const wrapped = withSecurityHeaders(original);
    expect(wrapped.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(wrapped.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
    // But other headers are still applied.
    expect(wrapped.headers.get("Strict-Transport-Security")).toBe(
      SECURITY_HEADERS["Strict-Transport-Security"],
    );
    expect(wrapped.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("pins HSTS to two years with subdomains + preload", () => {
    expect(SECURITY_HEADERS["Strict-Transport-Security"]).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
  });

  it("denies powerful browser features by default", () => {
    const policy = SECURITY_HEADERS["Permissions-Policy"];
    for (const feature of ["camera", "microphone", "geolocation", "payment"]) {
      expect(policy).toContain(`${feature}=()`);
    }
  });
});
