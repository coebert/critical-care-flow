/**
 * "Keep me signed in" as a dedicated auth storage adapter.
 *
 * The generated auth client stores its session through
 * `brokeredPreviewStorage()` (`localStorage`, or the editor preview broker
 * that mirrors it). `installSessionRetention()` swaps the client's storage
 * for {@link RetentionStorage} before the client first reads it:
 *
 * - Persistent sign-in ("Keep me signed in" ticked): every read and write is
 *   delegated unchanged to the generated broker/localStorage storage.
 * - Temporary sign-in (unticked): the session lives only in this tab's
 *   `sessionStorage`. It is never written to `localStorage` and never sent to
 *   the editor broker, so nothing outside this tab can hand it back.
 *
 * Choosing a temporary sign-in, signing out, or any removal by the auth client
 * also revokes the persistent copy. Because a broker removal can be lost (the
 * editor may be busy or gone), revoked keys are remembered in
 * `localStorage` and read as signed-out — without asking the broker — until a
 * new persistent session is written. A stale persistent session therefore
 * cannot come back after a temporary choice or a sign-out.
 *
 * Nothing here depends on `pagehide`, heartbeats or work during unload. The
 * browser decides how long `sessionStorage` lives: closing the tab normally
 * discards it, but "reopen closed tabs" / session restore can bring it back,
 * so the UI does not promise an end at browser close.
 *
 * Stored values are never logged or sent anywhere.
 */
import {
  brokeredPreviewStorage,
  type PreviewAuthStorage,
} from "@/integrations/supabase/previewAuthStorage";
import { supabase } from "@/integrations/supabase/client";

/** Per-tab marker (sessionStorage): this tab's sign-in is temporary. */
export const TAB_MODE_KEY = "sdh-auth-mode";
/** Shared (localStorage): auth keys whose persistent copy was revoked. */
export const REVOKED_KEY = "sdh-auth-revoked";

/** Keys written by the retired heartbeat/stash implementation. */
const LEGACY_FLAG_KEY = "sdh-auth-retention";
const LEGACY_LOCAL_KEYS = [LEGACY_FLAG_KEY, "sdh-auth-live-tabs"];
const LEGACY_SESSION_KEYS = ["sdh-auth-tab", "sdh-auth-tab-stash"];

const AUTH_KEY = /^sb-[A-Za-z0-9_-]+-auth-token(?:-code-verifier|-user)?$/;

/** Storage keys the auth client uses for a given base storage key. */
export function authKeysFor(storageKey: string): string[] {
  return [storageKey, `${storageKey}-code-verifier`, `${storageKey}-user`];
}

/** Same derivation as the auth client's default `storageKey`. */
export function defaultStorageKey(supabaseUrl: string): string {
  return `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
}

export interface RetentionEnv {
  /** Shared browser storage (null when blocked). */
  local: Storage | null;
  /** This tab's storage (null when blocked; an in-memory map is used then). */
  session: Storage | null;
  /** The generated broker/localStorage storage, used for persistent sessions. */
  persistent: PreviewAuthStorage;
  /** Base auth storage key, e.g. `sb-<ref>-auth-token`. */
  storageKey: string;
}

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    key: (i) => Array.from(m.keys())[i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function authKeysIn(store: Storage | null): string[] {
  if (!store) return [];
  return safe(() => {
    const out: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && AUTH_KEY.test(k)) out.push(k);
    }
    return out;
  }, []);
}

export class RetentionStorage implements PreviewAuthStorage {
  private readonly local: Storage | null;
  private readonly session: Storage;
  private readonly persistent: PreviewAuthStorage;
  private readonly keys: string[];
  /** Used when localStorage is blocked, so revocation still holds in this tab. */
  private readonly revokedFallback = new Set<string>();
  /** Broker removals re-sent at most once per key per page load. */
  private readonly resent = new Set<string>();

  constructor(env: RetentionEnv) {
    this.local = env.local;
    this.session = env.session ?? memoryStorage();
    this.persistent = env.persistent;
    this.keys = authKeysFor(env.storageKey);
  }

  /** True when this tab's sign-in is temporary (tab-only). */
  isTemporary(): boolean {
    return safe(() => this.session.getItem(TAB_MODE_KEY) === "tab", false);
  }

  private revoked(): Set<string> {
    const raw = this.local ? safe(() => this.local!.getItem(REVOKED_KEY), null) : null;
    const out = new Set(this.revokedFallback);
    if (raw) {
      const parsed = safe(() => JSON.parse(raw) as unknown, null);
      if (Array.isArray(parsed)) for (const k of parsed) if (typeof k === "string") out.add(k);
    }
    return out;
  }

  private writeRevoked(set: Set<string>): void {
    this.revokedFallback.clear();
    for (const k of set) this.revokedFallback.add(k);
    if (!this.local) return;
    safe(() => {
      if (set.size === 0) this.local!.removeItem(REVOKED_KEY);
      else this.local!.setItem(REVOKED_KEY, JSON.stringify([...set]));
    }, undefined);
  }

  /**
   * Revoke the persistent copy of `keys` (and, with `allLocal`, every auth
   * key in localStorage). The revocation is recorded first, so it holds even
   * if the broker never answers; local copies are removed synchronously.
   */
  private async revokePersistent(keys: string[], allLocal: boolean): Promise<void> {
    const set = this.revoked();
    for (const k of keys) set.add(k);
    this.writeRevoked(set);
    const pending = keys.map((k) =>
      Promise.resolve(safe(() => this.persistent.removeItem(k), undefined)).catch(() => undefined),
    );
    const localKeys = allLocal ? new Set([...keys, ...authKeysIn(this.local)]) : new Set(keys);
    for (const k of localKeys) if (this.local) safe(() => this.local!.removeItem(k), undefined);
    await Promise.all(pending);
  }

  private clearTabCopies(): void {
    for (const k of new Set([...this.keys, ...authKeysIn(this.session)])) {
      safe(() => this.session.removeItem(k), undefined);
    }
  }

  // ---- auth client storage interface --------------------------------------

  getItem(key: string): string | null | Promise<string | null> {
    if (this.isTemporary()) return safe(() => this.session.getItem(key), null);
    if (this.revoked().has(key)) {
      if (!this.resent.has(key)) {
        this.resent.add(key);
        return Promise.resolve(safe(() => this.persistent.removeItem(key), undefined))
          .catch(() => undefined)
          .then(() => null);
      }
      return null;
    }
    return this.persistent.getItem(key);
  }

  setItem(key: string, value: string): void | Promise<void> {
    if (this.isTemporary()) {
      this.session.setItem(key, value);
      return;
    }
    const set = this.revoked();
    if (set.delete(key)) this.writeRevoked(set);
    this.resent.delete(key);
    return this.persistent.setItem(key, value);
  }

  removeItem(key: string): void | Promise<void> {
    if (this.isTemporary()) safe(() => this.session.removeItem(key), undefined);
    return this.revokePersistent([key], false);
  }

  // ---- retention choice ----------------------------------------------------

  /**
   * Apply the "Keep me signed in" choice. Must run (and be awaited) before a
   * password or passkey sign-in writes the new session.
   */
  async choose(keepSignedIn: boolean): Promise<void> {
    this.clearTabCopies();
    if (keepSignedIn) {
      safe(() => this.session.removeItem(TAB_MODE_KEY), undefined);
      return;
    }
    this.session.setItem(TAB_MODE_KEY, "tab");
    // A temporary sign-in replaces any persistent session on this device.
    await this.revokePersistent(this.keys, true);
  }

  /** Sign-out: forget this tab's session and revoke the persistent copy. */
  async clear(): Promise<void> {
    this.clearTabCopies();
    safe(() => this.session.removeItem(TAB_MODE_KEY), undefined);
    await this.revokePersistent(this.keys, true);
  }

  /**
   * One-off clean-up of the retired heartbeat/stash implementation. A session
   * it marked tab-only is ended (never restored from its stash).
   */
  migrateLegacy(): void {
    const wasTabOnly = this.local ? safe(() => this.local!.getItem(LEGACY_FLAG_KEY) === "tab", false) : false;
    for (const k of LEGACY_LOCAL_KEYS) if (this.local) safe(() => this.local!.removeItem(k), undefined);
    for (const k of LEGACY_SESSION_KEYS) safe(() => this.session.removeItem(k), undefined);
    if (wasTabOnly) void this.revokePersistent(this.keys, true);
  }
}

// ---- browser wiring ---------------------------------------------------------

let browserStorage: RetentionStorage | null = null;

/**
 * Replace the generated auth client's storage with {@link RetentionStorage}.
 * Called from `getRouter()` before anything reads the session. The auth
 * client only starts reading storage after an async lock, so the swap made
 * synchronously right after the client is created is in place for its very
 * first read (guarded by session-retention.test.ts against the installed
 * auth library).
 */
export function attachRetentionStorage(auth: unknown, storage: PreviewAuthStorage): boolean {
  const target = auth as { storage?: unknown; persistSession?: unknown } | null;
  if (!target || typeof target !== "object" || !("storage" in target)) return false;
  target.storage = storage;
  return target.storage === storage;
}

export function installSessionRetention(): RetentionStorage | null {
  return installWith(supabase.auth, brokeredPreviewStorage);
}

/** Install against a given auth client (exported for tests). */
export function installWith(
  auth: unknown,
  makePersistent: () => PreviewAuthStorage | undefined,
): RetentionStorage | null {
  if (browserStorage) return browserStorage;
  if (typeof window === "undefined") return null;
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const persistent = makePersistent();
  if (!url || !persistent) return null;
  const storage = new RetentionStorage({
    local: safe(() => window.localStorage, null),
    session: safe(() => window.sessionStorage, null),
    persistent,
    storageKey: defaultStorageKey(url),
  });
  storage.migrateLegacy();
  if (!attachRetentionStorage(auth, storage)) {
    console.warn("[auth] keep-me-signed-in storage could not be attached");
    return null;
  }
  browserStorage = storage;
  return storage;
}

export class TemporarySignInUnavailableError extends Error {
  constructor() {
    super(
      "This browser can't keep a sign-in to this tab only. Tick \"Keep me signed in\" or use a private window, and sign out when you finish.",
    );
    this.name = "TemporarySignInUnavailableError";
  }
}

/**
 * Record the user's choice right before a sign-in attempt. Fails closed: an
 * unticked choice that cannot be honoured refuses to sign in.
 */
export async function chooseSessionRetention(keepSignedIn: boolean): Promise<void> {
  if (!browserStorage) {
    if (!keepSignedIn && typeof window !== "undefined") throw new TemporarySignInUnavailableError();
    return;
  }
  await browserStorage.choose(keepSignedIn);
}

/** Forget this tab's session and the persistent copy on sign-out. */
export async function clearSessionRetention(): Promise<void> {
  await browserStorage?.clear();
}

/** Test hook: forget the installed browser storage. */
export function __resetSessionRetentionForTests(): void {
  browserStorage = null;
}
