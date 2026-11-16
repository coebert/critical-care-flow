/**
 * "Keep me signed in" retention for the browser-held auth session.
 *
 * The generated auth client always persists its session through the same
 * storage (`localStorage`, or the editor preview broker that mirrors it) and
 * re-reads that storage on every `getSession()` and token refresh. Moving the
 * token elsewhere therefore signs the tab out immediately and the next token
 * refresh writes it straight back. Instead, a tab-only choice is enforced
 * around that storage:
 *
 * - While any tab of the tab-only session is open, the token stays where the
 *   auth client reads it, so reloads, refreshes and new sibling tabs work.
 * - Each open tab registers in a heartbeat table. When the last open tab is
 *   hidden for good (`pagehide`), the token is moved into that tab's own
 *   `sessionStorage`, which the browser discards on close. A same-tab reload
 *   puts it back before the auth client first reads storage.
 * - On start-up, a tab-only session with no live tab and nothing stashed in
 *   this tab's `sessionStorage` (browser closed, crashed or killed) is wiped,
 *   including the editor preview broker copy, before anything can read it.
 *
 * Stored values are never logged or sent anywhere.
 */

export const RETENTION_FLAG_KEY = "sdh-auth-retention";
export const TAB_MARK_KEY = "sdh-auth-tab";
export const TAB_STASH_KEY = "sdh-auth-tab-stash";
export const LIVE_TABS_KEY = "sdh-auth-live-tabs";
/** Background tabs may beat only once a minute (timer throttling). */
export const LIVE_TAB_TTL_MS = 120_000;
const HEARTBEAT_MS = 20_000;

const AUTH_KEY = /^sb-[A-Za-z0-9_-]+-auth-token(?:-code-verifier|-user)?$/;

export interface RetentionEnv {
  local: Storage;
  session: Storage;
  now: () => number;
  /** Revoke the editor preview broker's copy of a key (no-op off-preview). */
  revokeBroker?: (key: string) => void;
}

function browserEnv(): RetentionEnv | null {
  if (typeof window === "undefined") return null;
  try {
    return {
      local: window.localStorage,
      session: window.sessionStorage,
      now: () => Date.now(),
      revokeBroker: revokeBrokerCopy,
    };
  } catch {
    return null; // storage blocked
  }
}

function revokeBrokerCopy(key: string): void {
  // Only meaningful inside the editor preview frame, where the broker keeps
  // its own copy of the session. Fire-and-forget: the removal message is
  // posted synchronously, ahead of any later read request.
  if (window.parent === window) return;
  void import("@/integrations/supabase/previewAuthStorage")
    .then(({ brokeredPreviewStorage }) => {
      const s = brokeredPreviewStorage();
      if (s && s !== window.localStorage) return s.removeItem(key);
    })
    .catch(() => undefined);
}

function authKeys(store: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k && AUTH_KEY.test(k)) keys.push(k);
  }
  return keys;
}

function readTabs(env: RetentionEnv): Record<string, number> {
  try {
    const raw = env.local.getItem(LIVE_TABS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    const cutoff = env.now() - LIVE_TAB_TTL_MS;
    for (const [id, ts] of Object.entries(parsed as Record<string, unknown>)) {
      // Future timestamps (clock moved back) are treated as dead, not alive.
      if (typeof ts === "number" && ts >= cutoff && ts <= env.now() + HEARTBEAT_MS) out[id] = ts;
    }
    return out;
  } catch {
    return {};
  }
}

function writeTabs(env: RetentionEnv, tabs: Record<string, number>): void {
  if (Object.keys(tabs).length === 0) env.local.removeItem(LIVE_TABS_KEY);
  else env.local.setItem(LIVE_TABS_KEY, JSON.stringify(tabs));
}

function newTabId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function wipe(env: RetentionEnv): void {
  for (const k of authKeys(env.local)) {
    env.local.removeItem(k);
    env.revokeBroker?.(k);
  }
  env.local.removeItem(RETENTION_FLAG_KEY);
  env.local.removeItem(LIVE_TABS_KEY);
  env.session.removeItem(TAB_STASH_KEY);
  env.session.removeItem(TAB_MARK_KEY);
}

function restoreStash(env: RetentionEnv): void {
  const raw = env.session.getItem(TAB_STASH_KEY);
  env.session.removeItem(TAB_STASH_KEY);
  if (!raw) return;
  try {
    const stash = JSON.parse(raw) as Record<string, unknown>;
    for (const [k, v] of Object.entries(stash)) {
      // A sibling tab may hold a newer refreshed token: never overwrite it.
      if (AUTH_KEY.test(k) && typeof v === "string" && env.local.getItem(k) === null) {
        env.local.setItem(k, v);
      }
    }
  } catch {
    /* corrupt stash: drop it */
  }
}

export type StartupOutcome = "persistent" | "continued" | "adopted" | "ended";

/**
 * Apply the retention choice before the auth client first reads storage.
 * Synchronous and safe to call more than once.
 */
export function enforceSessionRetention(env: RetentionEnv | null = browserEnv()): StartupOutcome {
  if (!env) return "persistent";
  try {
    if (env.local.getItem(RETENTION_FLAG_KEY) !== "tab") {
      env.session.removeItem(TAB_STASH_KEY);
      env.session.removeItem(TAB_MARK_KEY);
      return "persistent";
    }
    const tabs = readTabs(env);
    let id = env.session.getItem(TAB_MARK_KEY);
    let outcome: StartupOutcome;
    if (id) {
      outcome = "continued"; // same-tab reload / restore
    } else if (Object.keys(tabs).length > 0 && authKeys(env.local).length > 0) {
      id = newTabId(); // a sibling tab of the same browser session is open
      env.session.setItem(TAB_MARK_KEY, id);
      outcome = "adopted";
    } else {
      wipe(env); // browser was closed (or crashed): the session ends here
      return "ended";
    }
    restoreStash(env);
    tabs[id] = env.now();
    writeTabs(env, tabs);
    return outcome;
  } catch {
    return "persistent";
  }
}

/** Record the user's choice right before a sign-in attempt. */
export function chooseSessionRetention(
  keepSignedIn: boolean,
  env: RetentionEnv | null = browserEnv(),
): void {
  if (!env) return;
  try {
    env.session.removeItem(TAB_STASH_KEY);
    if (keepSignedIn) {
      env.local.removeItem(RETENTION_FLAG_KEY);
      env.local.removeItem(LIVE_TABS_KEY);
      env.session.removeItem(TAB_MARK_KEY);
      return;
    }
    const id = env.session.getItem(TAB_MARK_KEY) ?? newTabId();
    env.session.setItem(TAB_MARK_KEY, id);
    env.local.setItem(RETENTION_FLAG_KEY, "tab");
    writeTabs(env, { ...readTabs(env), [id]: env.now() });
  } catch {
    /* storage blocked: nothing persisted either */
  }
}

/** Forget any retention state on sign-out. */
export function clearSessionRetention(env: RetentionEnv | null = browserEnv()): void {
  if (!env) return;
  try {
    env.local.removeItem(RETENTION_FLAG_KEY);
    env.local.removeItem(LIVE_TABS_KEY);
    env.session.removeItem(TAB_STASH_KEY);
    env.session.removeItem(TAB_MARK_KEY);
  } catch {
    /* ignore */
  }
}

/** Keep this tab's heartbeat fresh. */
export function heartbeat(env: RetentionEnv | null = browserEnv()): void {
  if (!env) return;
  try {
    if (env.local.getItem(RETENTION_FLAG_KEY) !== "tab") return;
    const id = env.session.getItem(TAB_MARK_KEY);
    if (!id) return;
    writeTabs(env, { ...readTabs(env), [id]: env.now() });
  } catch {
    /* ignore */
  }
}

/**
 * This tab is going away (close, navigate off-site, reload). If it was the
 * last live tab of a tab-only session, take the token out of shared storage
 * and keep it only in this tab's sessionStorage, which the browser discards
 * when it closes and a reload restores.
 */
export function onTabHidden(env: RetentionEnv | null = browserEnv()): void {
  if (!env) return;
  try {
    if (env.local.getItem(RETENTION_FLAG_KEY) !== "tab") return;
    const id = env.session.getItem(TAB_MARK_KEY);
    const tabs = readTabs(env);
    if (id) delete tabs[id];
    writeTabs(env, tabs);
    if (Object.keys(tabs).length > 0) return;
    const stash: Record<string, string> = {};
    for (const k of authKeys(env.local)) {
      const v = env.local.getItem(k);
      if (v !== null) stash[k] = v;
      env.local.removeItem(k);
    }
    if (Object.keys(stash).length > 0) env.session.setItem(TAB_STASH_KEY, JSON.stringify(stash));
  } catch {
    /* ignore */
  }
}

let installed = false;

/**
 * Browser start-up hook: enforce the choice now (before the auth client
 * reads storage) and keep this tab registered while it is open.
 */
export function installSessionRetention(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  enforceSessionRetention();
  const beat = () => heartbeat();
  window.setInterval(beat, HEARTBEAT_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") beat();
  });
  window.addEventListener("pagehide", () => onTabHidden());
  window.addEventListener("pageshow", (e) => {
    // Back/forward cache restore: re-enter the session like a reload.
    if ((e as PageTransitionEvent).persisted) enforceSessionRetention();
  });
}
