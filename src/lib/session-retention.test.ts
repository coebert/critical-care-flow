// Synthetic only: fake editor parent, fake auth server, made-up tokens.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { MemoryStorage } from "@/test-utils/memory-storage";
import { brokeredPreviewStorage } from "@/integrations/supabase/previewAuthStorage";
import {
  REVOKED_KEY,
  RetentionStorage,
  TAB_MODE_KEY,
  TemporarySignInUnavailableError,
  __resetSessionRetentionForTests,
  attachRetentionStorage,
  chooseSessionRetention,
} from "./session-retention";

const REF = "testref";
const KEY = `sb-${REF}-auth-token`;
const URL_ = `https://${REF}.supabase.test`;
const EDITOR = "https://lovable.dev";
const HOST = "id-preview--00000000-0000-4000-8000-000000000abc.lovable.app";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (tag: string, sub: string) =>
  `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, tag, exp: Math.floor(Date.now() / 1000) + 3600, aud: "authenticated", role: "authenticated" })}.synthetic-sig`;
const user = (sub: string) => ({ id: sub, aud: "authenticated", role: "authenticated", email: `${sub.slice(-4)}@example.test` });
const UA = "00000000-0000-4000-8000-00000000000a";
const UB = "00000000-0000-4000-8000-00000000000b";
const stored = (tag: string, sub = UA) =>
  JSON.stringify({ access_token: jwt(tag, sub), refresh_token: `r-${tag}`, token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: user(sub) });
const tagOf = (token: string | undefined) =>
  token ? (JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as { tag: string }).tag : null;

const editors: FakeEditor[] = [];

/** Mock trusted editor: keeps its own copy of the session, may go silent or answer late. */
class FakeEditor {
  store = new Map<string, string>();
  log: { type: string; key: string }[] = [];
  online = true;
  delayMs = 0;
  timers = new Set<ReturnType<typeof setTimeout>>();
  constructor(private win: EventTarget) {
    editors.push(this);
  }
  postMessage(msg: { type: string; requestId: string; key: string; value?: string }, origin: string) {
    if (origin !== EDITOR) return;
    this.log.push({ type: msg.type.split(":")[1], key: msg.key });
    if (!this.online) return;
    let value: string | null;
    if (msg.type.endsWith(":get")) value = this.store.has(msg.key) ? (this.store.get(msg.key) as string) : null;
    else if (msg.type.endsWith(":set")) {
      this.store.set(msg.key, msg.value ?? "");
      value = msg.value ?? "";
    } else {
      this.store.set(msg.key, ""); // logout tombstone
      value = "";
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      const ev = new Event("message") as Event & { origin: string; data: unknown };
      Object.assign(ev, { origin: EDITOR, data: { type: "lovable-preview-auth:result", requestId: msg.requestId, ok: true, value } });
      this.win.dispatchEvent(ev);
    }, this.delayMs);
    this.timers.add(timer);
  }
  gets() {
    return this.log.filter((l) => l.type === "get").length;
  }
}

/** One browser profile inside the editor preview frame. */
function browser() {
  const win = new EventTarget() as EventTarget & Record<string, unknown>;
  const editor = new FakeEditor(win);
  const local = new MemoryStorage();
  win.parent = editor;
  win.localStorage = local;
  const doc = Object.assign(new EventTarget(), { referrer: "", visibilityState: "visible" });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("location", { hostname: HOST, ancestorOrigins: [EDITOR], href: `https://${HOST}/` });

  const tab = (session = new MemoryStorage()) => {
    const broker = brokeredPreviewStorage();
    if (!broker || broker === (local as unknown)) throw new Error("expected the editor broker");
    const storage = new RetentionStorage({ local, session, persistent: broker, storageKey: KEY });
    storage.migrateLegacy();
    const authServer = fakeAuthServer();
    // Same wiring as the generated client, then the swap installSessionRetention makes.
    const client = createClient(URL_, "synthetic-anon", {
      auth: { storage: broker, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: authServer.fetch },
    });
    expect(attachRetentionStorage(client.auth, storage)).toBe(true);
    return { session, storage, client, authServer };
  };
  return { editor, local, tab };
}

function fakeAuthServer() {
  let n = 0;
  let nextSub = UA;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/logout")) return new Response(null, { status: 204 });
    if (url.includes("grant_type=")) {
      n += 1;
      const grant = new URL(url).searchParams.get("grant_type");
      const tag = `${grant === "refresh_token" ? "refreshed" : "signin"}-${n}`;
      const body = { access_token: jwt(tag, nextSub), refresh_token: `r-${tag}`, token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: user(nextSub) };
      void init;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
  };
  return { fetch, as: (sub: string) => (nextSub = sub) };
}

const signIn = async (t: ReturnType<ReturnType<typeof browser>["tab"]>, keep: boolean, sub = UA) => {
  await t.storage.choose(keep);
  t.authServer.as(sub);
  const { error } = await t.client.auth.signInWithPassword({ email: "synthetic@example.test", password: "synthetic-pw" });
  expect(error).toBeNull();
};
const current = async (t: ReturnType<ReturnType<typeof browser>["tab"]>) =>
  tagOf((await t.client.auth.getSession()).data.session?.access_token);

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => {
  // Late editor replies must not land after this test's globals are gone.
  for (const e of editors.splice(0)) for (const t of e.timers) clearTimeout(t);
  vi.unstubAllGlobals();
});

describe("reported regression: temporary session resurrected by the editor broker", () => {
  it("a new tab after the temporary tab is gone stays signed out, with zero broker reads", async () => {
    const b = browser();
    // A previous persistent sign-in left a copy in localStorage and the editor.
    b.local.setItem(KEY, stored("old-persistent"));
    b.editor.store.set(KEY, stored("old-persistent"));

    const t1 = b.tab();
    await signIn(t1, false);
    expect(await current(t1)).toBe("signin-1");
    // The temporary token is only in this tab: not local, never sent to the editor.
    expect(t1.session.getItem(KEY)).toContain(".");
    expect(b.local.getItem(KEY)).toBeNull();
    expect(b.editor.store.get(KEY)).toBe(""); // old persistent copy revoked
    expect(b.editor.log.some((l) => l.type === "set")).toBe(false);
    expect(b.editor.gets()).toBe(0);

    // Discard the tab's sessionStorage; open a fresh tab and read via the real broker.
    const t2 = b.tab();
    expect(await current(t2)).toBeNull();
    expect(b.local.getItem(KEY)).toBeNull(); // not reseeded
    expect(b.editor.gets()).toBe(0);
  });

  it("broker outage while choosing temporary: the stale editor copy is never read back", async () => {
    const b = browser();
    b.editor.store.set(KEY, stored("old-persistent"));
    b.editor.online = false; // removal message is lost
    const t1 = b.tab();
    await signIn(t1, false);
    expect(b.editor.store.get(KEY)).toContain("."); // editor still holds the stale token
    expect(JSON.parse(b.local.getItem(REVOKED_KEY) ?? "[]")).toContain(KEY);

    const t2 = b.tab();
    expect(await current(t2)).toBeNull();
    expect(b.local.getItem(KEY)).toBeNull();
    expect(b.editor.gets()).toBe(0);

    // Editor comes back: the re-sent removal clears its copy, still no read.
    b.editor.online = true;
    const t3 = b.tab();
    expect(await current(t3)).toBeNull();
    expect(b.editor.store.get(KEY)).toBe("");
    expect(b.editor.gets()).toBe(0);
  }, 20_000);
});

describe("temporary sign-in (Keep me signed in unticked)", () => {
  it("survives a reload of the same tab and keeps token refreshes in the tab", async () => {
    const b = browser();
    const t1 = b.tab();
    await signIn(t1, false);
    const reload = b.tab(t1.session); // same tab, new page load
    expect(await current(reload)).toBe("signin-1");
    const { error } = await reload.client.auth.refreshSession();
    expect(error).toBeNull();
    expect(await current(reload)).toBe("refreshed-1");
    expect(tagOf(JSON.parse(t1.session.getItem(KEY) ?? "{}").access_token)).toBe("refreshed-1");
    expect(b.local.getItem(KEY)).toBeNull();
    expect(b.editor.log.some((l) => l.type === "set")).toBe(false);
  });

  it("is per tab: other tabs are not signed in by it", async () => {
    const b = browser();
    const t1 = b.tab();
    await signIn(t1, false);
    const t2 = b.tab();
    expect(await current(t2)).toBeNull();
    expect(await current(t1)).toBe("signin-1");
  });

  it("sign-out clears the tab and revokes any persistent copy", async () => {
    const b = browser();
    const t1 = b.tab();
    await signIn(t1, false);
    await t1.client.auth.signOut();
    await t1.storage.clear();
    expect(t1.session.getItem(KEY)).toBeNull();
    expect(t1.session.getItem(TAB_MODE_KEY)).toBeNull();
    expect(await current(b.tab(t1.session))).toBeNull(); // reload after sign-out
  });
});

describe("persistent sign-in (Keep me signed in ticked)", () => {
  it("keeps the broker/localStorage behaviour across tabs and reloads", async () => {
    const b = browser();
    const t1 = b.tab();
    await signIn(t1, true);
    expect(b.local.getItem(KEY)).toContain(".");
    expect(b.editor.store.get(KEY)).toContain(".");
    // A brand-new origin storage (editor-only copy) is reseeded from the editor.
    b.local.removeItem(KEY);
    const t2 = b.tab();
    expect(await current(t2)).toBe("signin-1");
    expect(b.local.getItem(KEY)).toContain(".");
  });

  it("a delayed editor reply falls back to the local copy", async () => {
    const b = browser();
    const t1 = b.tab();
    await signIn(t1, true);
    b.editor.delayMs = 2_500; // longer than the broker timeout
    const t2 = b.tab();
    expect(await current(t2)).toBe("signin-1");
  }, 20_000);

  it("removing the code verifier does not sign the tab out", async () => {
    const b = browser();
    const t1 = b.tab();
    await signIn(t1, true);
    await t1.storage.removeItem(`${KEY}-code-verifier`);
    expect(await current(b.tab())).toBe("signin-1");
  });

  it("sign-out with the editor offline cannot be undone by its stale copy", async () => {
    const b = browser();
    const t1 = b.tab();
    await signIn(t1, true);
    b.editor.online = false;
    await t1.client.auth.signOut();
    await t1.storage.clear();
    expect(b.editor.store.get(KEY)).toContain("."); // stale copy still there
    const before = b.editor.gets();
    expect(await current(b.tab())).toBeNull();
    expect(b.local.getItem(KEY)).toBeNull();
    expect(b.editor.gets()).toBe(before);
  }, 20_000);
});

describe("identity changes and the retired implementation", () => {
  it("user A temporary, sign-out, user B persistent: only B is ever readable", async () => {
    const b = browser();
    const t1 = b.tab();
    await signIn(t1, false, UA);
    await t1.client.auth.signOut();
    await t1.storage.clear();
    await signIn(t1, true, UB);
    const t2 = b.tab();
    const s = (await t2.client.auth.getSession()).data.session;
    expect(s?.user.id).toBe(UB);
    expect(JSON.parse(b.local.getItem(REVOKED_KEY) ?? "[]")).not.toContain(KEY);
  });

  it("switching a temporary tab to persistent drops the tab copy", async () => {
    const b = browser();
    const t1 = b.tab();
    await signIn(t1, false, UA);
    await signIn(t1, true, UB);
    expect(t1.session.getItem(KEY)).toBeNull();
    expect((await b.tab().client.auth.getSession()).data.session?.user.id).toBe(UB);
  });

  it("an old tab-only session and its stash are ended, never restored", async () => {
    const b = browser();
    const tabSession = new MemoryStorage();
    b.local.setItem("sdh-auth-retention", "tab");
    b.local.setItem("sdh-auth-live-tabs", JSON.stringify({ x: Date.now() }));
    b.local.setItem(KEY, stored("legacy-a"));
    b.editor.store.set(KEY, stored("legacy-a"));
    tabSession.setItem("sdh-auth-tab", "x");
    tabSession.setItem("sdh-auth-tab-stash", JSON.stringify({ [KEY]: stored("legacy-a") }));
    const t = b.tab(tabSession);
    expect(await current(t)).toBeNull();
    expect(b.local.getItem(KEY)).toBeNull();
    expect(b.local.getItem("sdh-auth-retention")).toBeNull();
    expect(tabSession.getItem("sdh-auth-tab-stash")).toBeNull();
    expect(b.editor.gets()).toBe(0);
  });
});

describe("fail closed", () => {
  it("an unticked sign-in is refused when the tab-only storage is not installed", async () => {
    __resetSessionRetentionForTests();
    vi.stubGlobal("window", new EventTarget());
    await expect(chooseSessionRetention(false)).rejects.toBeInstanceOf(TemporarySignInUnavailableError);
    await expect(chooseSessionRetention(true)).resolves.toBeUndefined();
  });

  it("refuses to attach to an object that is not an auth client", () => {
    expect(attachRetentionStorage({}, new MemoryStorage())).toBe(false);
    expect(attachRetentionStorage(null, new MemoryStorage())).toBe(false);
  });
});
