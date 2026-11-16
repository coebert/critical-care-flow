import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { MemoryStorage } from "@/test-utils/memory-storage";
import {
  LIVE_TAB_TTL_MS,
  RETENTION_FLAG_KEY,
  chooseSessionRetention,
  clearSessionRetention,
  enforceSessionRetention,
  heartbeat,
  onTabHidden,
  type RetentionEnv,
} from "./session-retention";

const KEY = "sb-testref-auth-token";
const session = (tag: string) =>
  JSON.stringify({
    access_token: `synthetic-${tag}`,
    refresh_token: `r-${tag}`,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", email: "synthetic@example.test" },
  });

/** One browser profile: shared localStorage, per-tab sessionStorage. */
function browser() {
  const local = new MemoryStorage();
  let t = 1_000_000;
  const revoked: string[] = [];
  const tab = (session = new MemoryStorage()): RetentionEnv & { session: MemoryStorage } => ({
    local,
    session,
    now: () => t,
    revokeBroker: (k) => revoked.push(k),
  });
  return { local, tab, revoked, advance: (ms: number) => (t += ms) };
}

describe("Keep me signed in = off (tab-only)", () => {
  it("survives a same-tab reload, then ends when the browser closes", () => {
    const b = browser();
    const t1 = b.tab();
    chooseSessionRetention(false, t1);
    b.local.setItem(KEY, session("a")); // auth client stores the session
    onTabHidden(t1); // reload starts: last tab hides
    expect(b.local.getItem(KEY)).toBeNull(); // not left in shared storage
    expect(enforceSessionRetention(b.tab(t1.session))).toBe("continued"); // same tab reloads
    expect(b.local.getItem(KEY)).toBe(session("a"));

    onTabHidden(t1); // browser closes: sessionStorage is discarded
    expect(enforceSessionRetention(b.tab())).toBe("ended");
    expect(b.local.getItem(KEY)).toBeNull();
    expect(b.local.getItem(RETENTION_FLAG_KEY)).toBeNull();
  });

  it("a token refresh written back to storage is still ended on browser close", () => {
    const b = browser();
    const t1 = b.tab();
    chooseSessionRetention(false, t1);
    b.local.setItem(KEY, session("a"));
    b.local.setItem(KEY, session("refreshed")); // autoRefresh rewrites it
    onTabHidden(t1);
    expect(enforceSessionRetention(b.tab())).toBe("ended");
    expect(b.local.getItem(KEY)).toBeNull();
  });

  it("a crash (no pagehide) ends the session once the tab heartbeat is stale", () => {
    const b = browser();
    const t1 = b.tab();
    chooseSessionRetention(false, t1);
    b.local.setItem(KEY, session("a"));
    b.advance(LIVE_TAB_TTL_MS + 1);
    expect(enforceSessionRetention(b.tab())).toBe("ended");
    expect(b.local.getItem(KEY)).toBeNull();
    expect(b.revoked).toEqual([KEY]); // editor preview broker copy revoked too
  });

  it("a new tab joins while a sibling tab is open; closing one keeps the other signed in", () => {
    const b = browser();
    const t1 = b.tab();
    chooseSessionRetention(false, t1);
    b.local.setItem(KEY, session("a"));
    b.advance(30_000);
    heartbeat(t1);
    const t2 = b.tab();
    expect(enforceSessionRetention(t2)).toBe("adopted");
    onTabHidden(t2);
    expect(b.local.getItem(KEY)).toBe(session("a"));
    onTabHidden(t1);
    expect(b.local.getItem(KEY)).toBeNull();
  });

  it("a heartbeat stamped in the future (clock moved back) does not keep a session alive", () => {
    const b = browser();
    const t1 = b.tab();
    chooseSessionRetention(false, t1);
    b.local.setItem(KEY, session("a"));
    b.advance(-10 * 60_000);
    expect(enforceSessionRetention(b.tab())).toBe("ended");
  });
});

describe("Keep me signed in = on, and sign-out", () => {
  it("persistent sessions survive browser close", () => {
    const b = browser();
    chooseSessionRetention(true, b.tab());
    b.local.setItem(KEY, session("a"));
    expect(enforceSessionRetention(b.tab())).toBe("persistent");
    expect(b.local.getItem(KEY)).toBe(session("a"));
  });

  it("switching to keep-signed-in clears an earlier tab-only choice", () => {
    const b = browser();
    const t1 = b.tab();
    chooseSessionRetention(false, t1);
    chooseSessionRetention(true, t1);
    b.local.setItem(KEY, session("b"));
    onTabHidden(t1);
    expect(enforceSessionRetention(b.tab())).toBe("persistent");
    expect(b.local.getItem(KEY)).toBe(session("b"));
  });

  it("sign-out forgets the retention state", () => {
    const b = browser();
    const t1 = b.tab();
    chooseSessionRetention(false, t1);
    clearSessionRetention(t1);
    expect(b.local.getItem(RETENTION_FLAG_KEY)).toBeNull();
    expect(t1.session.length).toBe(0);
  });
});

describe("with the real auth client reading storage", () => {
  const client = (local: Storage) =>
    createClient("http://127.0.0.1:9", "synthetic-anon", {
      auth: { storage: local, storageKey: KEY, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: () => Promise.reject(new Error("offline test")) },
    });

  it("tab-only session is readable after reload and gone after browser close", async () => {
    const b = browser();
    const t1 = b.tab();
    chooseSessionRetention(false, t1);
    b.local.setItem(KEY, session("a"));
    expect((await client(b.local).auth.getSession()).data.session?.access_token).toBe("synthetic-a");

    onTabHidden(t1);
    enforceSessionRetention(b.tab(t1.session)); // reload of the same tab
    expect((await client(b.local).auth.getSession()).data.session?.access_token).toBe("synthetic-a");

    onTabHidden(t1);
    enforceSessionRetention(b.tab()); // new browser session
    expect((await client(b.local).auth.getSession()).data.session).toBeNull();
  });
});
