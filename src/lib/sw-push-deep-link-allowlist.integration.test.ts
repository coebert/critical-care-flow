import { describe, it, expect } from "vitest";

/**
 * Extended P2 tests for the push service worker's deep-link allow-list
 * and payload sanitisation — see `public/sw-push.js`.
 *
 * The service worker file cannot be imported directly (classic worker
 * script running in a Worker global with `self.location.origin`), so
 * this file is a faithful port of the two pure helpers:
 *
 *   - `safeSameOriginPath(rawUrl)` rewrites a push-payload URL to a
 *     safe same-origin path. Anything cross-origin, an unknown path,
 *     or a malformed URL collapses to `"/"`.
 *   - `sanitizeString(v, max)` drops non-string payload fields and
 *     caps string length.
 *
 * IF YOU CHANGE `public/sw-push.js` YOU MUST MIRROR THE CHANGE HERE.
 *
 * Regressions covered:
 *   - `startsWith` prefix-confusion: `/inboxevil` masquerading as
 *     `/inbox`, `/referrals-fake` as `/referrals`, etc. A single naive
 *     `startsWith(p)` check would let these through and steer users
 *     to attacker-controlled routes inside our own origin.
 *   - Cross-origin URLs in a push payload (attacker phishing page).
 *   - Protocol-relative (`//attacker.com/x`), `javascript:`, `data:`,
 *     and malformed URLs.
 *   - Unknown allow-list-adjacent paths (`/admins`, `/inbox2`).
 *   - Non-string / object / null / undefined title/body/tag fields
 *     that a compromised sender could inject.
 *   - Length caps: 200 (title), 500 (body), 100 (tag).
 *   - Query strings preserved on allowed paths; hash fragments dropped
 *     (the SW never round-trips them into a client navigation URL).
 */

// -------------------------------------------------------------------
// Faithful port of the two pure helpers in `public/sw-push.js`.
// -------------------------------------------------------------------

const ORIGIN = "https://critical-care-flow.lovable.app";

const ALLOWED_PATH_PREFIXES = [
  "/",
  "/inbox",
  "/referrals",
  "/notifications",
  "/bed-board",
  "/board",
  "/analytics",
  "/profile",
  "/postop-bookings",
  "/bridge-status",
  "/admin",
  "/permissions",
];

function sanitizeString(v: unknown, max = 200): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function safeSameOriginPath(rawUrl: string): string {
  try {
    const u = new URL(rawUrl, ORIGIN);
    if (u.origin !== ORIGIN) return "/";
    const path = u.pathname || "/";
    const ok = ALLOWED_PATH_PREFIXES.some(
      (p) => path === p || (p !== "/" && path.startsWith(p + "/")),
    );
    return ok ? u.pathname + u.search : "/";
  } catch (_) {
    return "/";
  }
}

// -------------------------------------------------------------------
// safeSameOriginPath — allowed cases
// -------------------------------------------------------------------

describe("safeSameOriginPath: allow-list acceptance", () => {
  it.each([
    ["/", "/"],
    ["/inbox", "/inbox"],
    ["/inbox/123", "/inbox/123"],
    ["/referrals", "/referrals"],
    ["/referrals/abc-123", "/referrals/abc-123"],
    ["/notifications", "/notifications"],
    ["/bed-board", "/bed-board"],
    ["/board/ward-round", "/board/ward-round"],
    ["/analytics", "/analytics"],
    ["/profile", "/profile"],
    ["/postop-bookings/planner", "/postop-bookings/planner"],
    ["/bridge-status", "/bridge-status"],
    ["/admin", "/admin"],
    ["/permissions", "/permissions"],
  ])("passes %s through unchanged", (input, expected) => {
    expect(safeSameOriginPath(input)).toBe(expected);
  });

  it("preserves query strings on allowed paths", () => {
    expect(safeSameOriginPath("/referrals?filter=urgent")).toBe(
      "/referrals?filter=urgent",
    );
    expect(safeSameOriginPath("/inbox/42?tab=history")).toBe(
      "/inbox/42?tab=history",
    );
  });

  it("drops hash fragments — SW navigates by path+search only", () => {
    // pathname + search excludes hash by construction.
    expect(safeSameOriginPath("/inbox#secret")).toBe("/inbox");
    expect(safeSameOriginPath("/referrals/9#tab=notes")).toBe("/referrals/9");
  });

  it("accepts absolute same-origin URLs", () => {
    expect(safeSameOriginPath(`${ORIGIN}/inbox/1`)).toBe("/inbox/1");
    expect(safeSameOriginPath(`${ORIGIN}/`)).toBe("/");
  });
});

// -------------------------------------------------------------------
// safeSameOriginPath — prefix-confusion protection (the P2 bug fix)
// -------------------------------------------------------------------

describe("safeSameOriginPath: prefix-confusion attacks fall back to /", () => {
  it.each([
    "/inboxevil",
    "/inbox-attacker",
    "/inbox2",
    "/referralsfake",
    "/referrals-external",
    "/notificationsxyz",
    "/adminfake",
    "/admins",
    "/permissionsxyz",
    "/bed-boardevil",
    "/boardxyz",
    "/postop-bookingsfake",
    "/bridge-statusfake",
    "/analyticsfake",
    "/profileevil",
  ])("rejects %s (would match a naive startsWith check)", (path) => {
    expect(safeSameOriginPath(path)).toBe("/");
  });
});

// -------------------------------------------------------------------
// safeSameOriginPath — cross-origin & unsafe scheme protection
// -------------------------------------------------------------------

describe("safeSameOriginPath: cross-origin and unsafe schemes fall back to /", () => {
  it.each([
    "https://attacker.example/inbox",
    "http://phish.local/referrals/1",
    "https://critical-care-flow.lovable.app.attacker.com/inbox",
    // Protocol-relative → parsed as cross-origin (scheme inherits from base
    // but authority becomes `attacker.com`).
    "//attacker.com/inbox",
    "//attacker.com",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
  ])("rewrites %s → /", (input) => {
    expect(safeSameOriginPath(input)).toBe("/");
  });
});

// -------------------------------------------------------------------
// safeSameOriginPath — malformed / edge inputs never throw
// -------------------------------------------------------------------

describe("safeSameOriginPath: malformed inputs return / (never throw)", () => {
  it.each([
    "",
    " ",
    "not a url",
    ":::",
    "http://",
    "https://",
    // Zero-width / control chars in the path.
    "/inbox\u0000",
    "/inbox\r\n",
  ])("handles %j safely", (input) => {
    expect(() => safeSameOriginPath(input)).not.toThrow();
    // Either falls back to "/" or, if the URL parser accepts it as a
    // relative path, the result must still be a same-origin string
    // starting with "/".
    const out = safeSameOriginPath(input);
    expect(typeof out).toBe("string");
    expect(out.startsWith("/")).toBe(true);
  });
});

// -------------------------------------------------------------------
// sanitizeString — payload field validation
// -------------------------------------------------------------------

describe("sanitizeString: drops non-strings and caps length", () => {
  it("passes short strings through", () => {
    expect(sanitizeString("New referral")).toBe("New referral");
  });

  it.each([
    [null],
    [undefined],
    [123],
    [true],
    [{ toString: () => "evil" }],
    [["array", "of", "strings"]],
    [() => "fn"],
  ])("drops non-string value %j to empty string", (v) => {
    expect(sanitizeString(v)).toBe("");
  });

  it("caps title at 200 chars", () => {
    const long = "x".repeat(500);
    expect(sanitizeString(long)).toHaveLength(200);
  });

  it("caps body at 500 chars when max=500", () => {
    const long = "y".repeat(2000);
    expect(sanitizeString(long, 500)).toHaveLength(500);
  });

  it("caps tag at 100 chars when max=100", () => {
    const long = "z".repeat(400);
    expect(sanitizeString(long, 100)).toHaveLength(100);
  });
});

// -------------------------------------------------------------------
// End-to-end payload processing — mirrors the `push` event handler
// -------------------------------------------------------------------

type PushPayload = { title?: unknown; body?: unknown; url?: unknown; tag?: unknown };

function processPushPayload(raw: unknown): {
  title: string;
  body: string;
  url: string;
  tag: string | undefined;
} {
  const defaults = { title: "Radnor Critical Care", body: "New activity", url: "/", tag: undefined as string | undefined };
  const out = { ...defaults };
  if (raw && typeof raw === "object") {
    const p = raw as PushPayload;
    out.title = sanitizeString(p.title) || defaults.title;
    out.body = sanitizeString(p.body, 500) || defaults.body;
    out.url = safeSameOriginPath(sanitizeString(p.url) || "/");
    out.tag = sanitizeString(p.tag, 100) || undefined;
  }
  return out;
}

describe("processPushPayload: end-to-end sanitisation of a push payload", () => {
  it("keeps a well-formed payload intact", () => {
    expect(
      processPushPayload({
        title: "New urgent referral",
        body: "Patient AB — NEWS2 9",
        url: "/referrals/xyz-1",
        tag: "referral-xyz-1",
      }),
    ).toEqual({
      title: "New urgent referral",
      body: "Patient AB — NEWS2 9",
      url: "/referrals/xyz-1",
      tag: "referral-xyz-1",
    });
  });

  it("rewrites a cross-origin phishing URL to /", () => {
    const out = processPushPayload({
      title: "Click here",
      body: "Urgent",
      url: "https://phish.example/steal",
      tag: "abc",
    });
    expect(out.url).toBe("/");
  });

  it("rewrites a prefix-confusion URL to /", () => {
    const out = processPushPayload({
      title: "Click",
      body: "b",
      url: "/inboxevil/steal-token",
    });
    expect(out.url).toBe("/");
  });

  it("falls back to defaults when title/body are non-strings", () => {
    const out = processPushPayload({
      title: { html: "<script>alert(1)</script>" },
      body: 42,
      url: "/inbox",
    });
    expect(out.title).toBe("Radnor Critical Care");
    expect(out.body).toBe("New activity");
    expect(out.url).toBe("/inbox");
    expect(out.tag).toBeUndefined();
  });

  it("returns defaults on a non-object payload", () => {
    expect(processPushPayload(null)).toEqual({
      title: "Radnor Critical Care",
      body: "New activity",
      url: "/",
      tag: undefined,
    });
    expect(processPushPayload("string payload")).toEqual({
      title: "Radnor Critical Care",
      body: "New activity",
      url: "/",
      tag: undefined,
    });
  });

  it("caps overlong title/body/tag lengths", () => {
    const out = processPushPayload({
      title: "T".repeat(1000),
      body: "B".repeat(2000),
      url: "/inbox",
      tag: "G".repeat(400),
    });
    expect(out.title).toHaveLength(200);
    expect(out.body).toHaveLength(500);
    expect(out.tag).toHaveLength(100);
  });
});

// -------------------------------------------------------------------
// notificationclick target URL derivation — mirrors the handler shape
// -------------------------------------------------------------------

function targetUrlForClick(dataUrl: unknown): string {
  const raw = typeof dataUrl === "string" && dataUrl.length ? dataUrl : "/";
  const safe = safeSameOriginPath(raw);
  return new URL(safe, ORIGIN).href;
}

describe("notificationclick: target URL is always same-origin and allow-listed", () => {
  it("navigates to an allowed deep link", () => {
    expect(targetUrlForClick("/referrals/42")).toBe(
      `${ORIGIN}/referrals/42`,
    );
  });

  it("collapses a cross-origin data.url to the app root", () => {
    expect(targetUrlForClick("https://phish.example/x")).toBe(`${ORIGIN}/`);
  });

  it("collapses a prefix-confusion data.url to the app root", () => {
    expect(targetUrlForClick("/inbox-attacker")).toBe(`${ORIGIN}/`);
  });

  it("handles a missing data.url", () => {
    expect(targetUrlForClick(undefined)).toBe(`${ORIGIN}/`);
    expect(targetUrlForClick(null)).toBe(`${ORIGIN}/`);
    expect(targetUrlForClick("")).toBe(`${ORIGIN}/`);
  });

  it("handles a non-string data.url without throwing", () => {
    expect(targetUrlForClick(42 as unknown)).toBe(`${ORIGIN}/`);
    expect(targetUrlForClick({ href: "/inbox" } as unknown)).toBe(`${ORIGIN}/`);
  });
});
