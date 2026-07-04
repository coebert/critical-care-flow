import { create } from "zustand";
import { sodium, unwrapPrivateKey, generateAndWrapKeypair, type PrivateKeyMaterial } from "@/lib/e2e-crypto";
import { logRecipientKeyUnlock, getMyPrivateKeyMaterial } from "@/lib/e2e-keys.functions";

// Persistence policy:
// The unwrapped private key is cached in sessionStorage so a page refresh
// keeps you unlocked in the SAME tab, but it is NOT written to localStorage
// — long-term device storage would let anyone with access to the browser
// profile read every encrypted note. Closing the tab / signing out clears it.
const SESSION_KEY = "e2e.session.v1";

interface PersistedSession {
  publicKey: string;
  privateKeyB64: string; // base64 of unwrapped private key (session-only)
}

function readPersisted(): PersistedSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedSession;
    if (!parsed?.publicKey || !parsed?.privateKeyB64) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writePersisted(publicKey: string, priv: Uint8Array) {
  if (typeof window === "undefined") return;
  try {
    const s = await sodium();
    const privateKeyB64 = s.to_base64(priv, s.base64_variants.ORIGINAL);
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ publicKey, privateKeyB64 }));
  } catch {
    /* storage full or blocked — non-fatal, unlock still works this tab */
  }
}

function clearPersisted() {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

// Global, authoritative recipient-key status. Every authenticated page reads
// from this single source of truth so badges/buttons across the whole app
// refresh in the same tick whenever `unlock` / `bootstrap` / `refreshStatus`
// mutates it.
export type KeyStatus = "loading" | "ready" | "locked" | "not_issued";

function deriveStatus(
  publicKey: string | null,
  material: PrivateKeyMaterial | null,
  isUnlocked: boolean,
): KeyStatus {
  if (!publicKey || !material) return "not_issued";
  return isUnlocked ? "ready" : "locked";
}

interface E2EState {
  publicKey: string | null;
  privateKey: Uint8Array | null;
  isUnlocked: boolean;
  needsBootstrap: boolean; // no material stored yet
  material: PrivateKeyMaterial | null;
  hydrated: boolean; // sessionStorage rehydration attempted
  status: KeyStatus;
  refreshing: boolean;
  setMaterial: (material: PrivateKeyMaterial | null, publicKey: string | null) => void;
  unlock: (password: string) => Promise<void>;
  bootstrap: (
    password: string,
    publish: (m: {
      public_key: string;
      encrypted_private_key: string;
      kdf_salt: string;
      kdf_ops: number;
      kdf_mem: number;
      nonce: string;
    }) => Promise<unknown>,
  ) => Promise<void>;
  hydrateFromSession: () => Promise<boolean>;
  /**
   * Fetch the latest server-side key material, reconcile it with the local
   * session, and update `status` in a single atomic write. Safe to call
   * repeatedly — concurrent callers share the in-flight request.
   */
  refreshStatus: () => Promise<KeyStatus>;
  clear: () => void;
}

let inFlightRefresh: Promise<KeyStatus> | null = null;

export const useE2ESession = create<E2EState>((set, get) => ({
  publicKey: null,
  privateKey: null,
  isUnlocked: false,
  needsBootstrap: false,
  material: null,
  hydrated: false,
  status: "loading",
  refreshing: false,
  setMaterial: (material, publicKey) => {
    // If the stored public key still matches what we already unlocked in
    // this tab, keep the unlocked session alive across refresh.
    const cur = get();
    const stillValid = cur.isUnlocked && cur.publicKey === publicKey && !!cur.privateKey;
    const isUnlocked = stillValid;
    set({
      material,
      publicKey,
      needsBootstrap: !material || !publicKey,
      privateKey: stillValid ? cur.privateKey : null,
      isUnlocked,
      status: deriveStatus(publicKey, material, isUnlocked),
    });
    if (!stillValid) clearPersisted();
  },
  unlock: async (password: string) => {
    const { material, publicKey } = get();
    if (!material || !publicKey) throw new Error("No encrypted key stored yet.");
    const priv = await unwrapPrivateKey(password, material);
    set({
      privateKey: priv,
      isUnlocked: true,
      status: deriveStatus(publicKey, material, true),
    });
    await writePersisted(publicKey, priv);
    // Fire-and-forget audit: a fresh password unwrap in this tab. Rehydrating
    // an already-unlocked session (hydrateFromSession) does NOT audit again.
    logRecipientKeyUnlock({ data: { public_key: publicKey } }).catch(() => {
      /* audit failure must not block the unlock UX */
    });
  },
  bootstrap: async (password, publish) => {
    const { keypair, material } = await generateAndWrapKeypair(password);
    await publish({ public_key: keypair.publicKey, ...material });
    const priv = await unwrapPrivateKey(password, material);
    set({
      publicKey: keypair.publicKey,
      privateKey: priv,
      isUnlocked: true,
      needsBootstrap: false,
      material,
      status: deriveStatus(keypair.publicKey, material, true),
    });
    await writePersisted(keypair.publicKey, priv);
    // Server-side key material just changed → tell sibling tabs so their
    // profile / referral pages flip from "not_issued" to "locked" without
    // waiting for a reload.
    broadcastKeyChange("bootstrap");
  },
  hydrateFromSession: async () => {
    if (get().hydrated) return get().isUnlocked;
    const persisted = readPersisted();
    if (!persisted) {
      set({ hydrated: true });
      return false;
    }
    try {
      const s = await sodium();
      const priv = s.from_base64(persisted.privateKeyB64, s.base64_variants.ORIGINAL);
      set((cur) => ({
        publicKey: persisted.publicKey,
        privateKey: priv,
        isUnlocked: true,
        hydrated: true,
        // If material is already known, promote to ready. Otherwise stay
        // loading until refreshStatus() confirms the server-side record.
        status: cur.material ? "ready" : cur.status,
      }));
      return true;
    } catch {
      clearPersisted();
      set({ hydrated: true });
      return false;
    }
  },
  refreshStatus: async () => {
    if (inFlightRefresh) return inFlightRefresh;
    const prevStatus = get().status;
    const prevPub = get().publicKey;
    set({ refreshing: true });
    inFlightRefresh = (async () => {
      try {
        if (!get().hydrated) await get().hydrateFromSession();
        const res: any = await getMyPrivateKeyMaterial({ data: undefined as any });
        get().setMaterial(res?.material ?? null, res?.public_key ?? null);
        return get().status;
      } catch {
        // On failure we treat the key as not_issued rather than sticking on
        // "loading" forever; the user can retry from the profile page.
        set({ status: "not_issued" });
        return "not_issued" as const;
      } finally {
        set({ refreshing: false });
        inFlightRefresh = null;
      }
    })();
    const result = await inFlightRefresh;
    // Only broadcast when the observable state actually changed — a
    // no-op refresh must not create a ping-pong between tabs.
    if (get().status !== prevStatus || get().publicKey !== prevPub) {
      broadcastKeyChange("refresh");
    }
    return result;
  },
  clear: () => {
    clearPersisted();
    set({
      publicKey: null,
      privateKey: null,
      isUnlocked: false,
      needsBootstrap: false,
      material: null,
      status: "not_issued",
    });
    // Sign-out in one tab must lock every other tab too.
    broadcastKeyChange("clear");
  },
}));

/**
 * Convenience selector for consumers that only need the badge / button state.
 * Subscribes to the single `status` slice so components re-render exactly
 * when the key transitions between loading / ready / locked / not_issued.
 */
export function useKeyStatus(): KeyStatus {
  return useE2ESession((s) => s.status);
}

// ---------------------------------------------------------------------------
// Cross-tab propagation
// ---------------------------------------------------------------------------
// When one tab issues, refreshes, or clears the recipient key, every other
// tab open on the same origin must re-derive its badge/button state without
// a manual reload. BroadcastChannel is the right primitive: same-origin,
// per-user (localStorage isolation), and won't fire in the tab that posted.
//
// The private key itself is never broadcast — each tab still has to unlock
// with the password locally. The message is a pure "server-side key material
// changed, please re-fetch" ping.

const CHANNEL_NAME = "e2e-key-status.v1";
export type KeyChangeReason = "bootstrap" | "refresh" | "clear";
export interface KeyChangeMessage {
  reason: KeyChangeReason;
  // A monotonically-increasing id lets tests / consumers de-dupe if they
  // ever want to; the receiver here doesn't need it, but including it
  // future-proofs the wire format.
  seq: number;
}

let channel: BroadcastChannel | null = null;
let seq = 0;
// Set by tests (and any embedding that wants an alternate transport). When
// null, we fall back to a real BroadcastChannel in browsers.
let transportOverride: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (transportOverride) return transportOverride;
  if (channel) return channel;
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
  } catch {
    channel = null;
  }
  return channel;
}

function broadcastKeyChange(reason: KeyChangeReason): void {
  const c = getChannel();
  if (!c) return;
  try {
    c.postMessage({ reason, seq: ++seq } satisfies KeyChangeMessage);
  } catch {
    /* transport closed — non-fatal */
  }
}

/**
 * Wire up cross-tab key-status sync. Call once from the authenticated shell.
 * Returns a teardown fn for tests / hot-reload.
 */
export function initKeyStatusCrossTabSync(): () => void {
  const c = getChannel();
  if (!c) return () => {};
  const handler = (ev: MessageEvent<KeyChangeMessage>) => {
    const msg = ev?.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.reason === "clear") {
      // A sibling signed out — drop our local unlocked session so a
      // subsequent visit to this tab doesn't leak the previous user's key.
      useE2ESession.getState().clear();
      return;
    }
    // Any other reason means server-side material may have changed. Let
    // refreshStatus() reconcile — it de-dupes concurrent callers.
    useE2ESession.getState().refreshStatus().catch(() => { /* non-fatal */ });
  };
  c.addEventListener("message", handler);
  return () => {
    try { c.removeEventListener("message", handler); } catch { /* ignore */ }
  };
}

/** Test-only: swap the BroadcastChannel implementation. */
export function __setKeyStatusTransport(t: BroadcastChannel | null): void {
  transportOverride = t;
  channel = null;
}

