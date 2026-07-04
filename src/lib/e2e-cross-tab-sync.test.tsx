// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";

// The BroadcastChannel Node ships with is process-scoped and cross-realm,
// which is perfect: two independent Zustand stores in the same test can talk
// to each other over the same channel name just like two browser tabs would.
// We do NOT stub it — we exercise the real transport.

const { getMaterialSpy } = vi.hoisted(() => ({
  getMaterialSpy: vi.fn(),
}));

vi.mock("@/lib/e2e-crypto", () => ({
  sodium: async () => ({
    to_base64: (u: Uint8Array) => Buffer.from(u).toString("base64"),
    from_base64: (s: string) => new Uint8Array(Buffer.from(s, "base64")),
    base64_variants: { ORIGINAL: 1 },
  }),
  unwrapPrivateKey: vi.fn(async () => new Uint8Array([1, 2, 3])),
  generateAndWrapKeypair: vi.fn(),
}));

vi.mock("@/lib/e2e-keys.functions", () => ({
  logRecipientKeyUnlock: vi.fn(async () => ({ ok: true })),
  getMyPrivateKeyMaterial: getMaterialSpy,
  publishUserKeys: vi.fn(async () => ({ ok: true })),
  reissueRecipientKeypair: vi.fn(),
}));

// Stub useAuth so ProfilePage renders without a live Supabase session.
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: "user-1", email: "user@example.com" } }),
  useRole: () => ({ hasRole: false }),
}));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));

// Bypass createFileRoute — we render the page component directly.
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (cfg: any) => ({ ...cfg, options: cfg }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import {
  useE2ESession,
  initKeyStatusCrossTabSync,
  __setKeyStatusTransport,
} from "@/hooks/use-e2e-session";
import { Route as ProfileRoute } from "@/routes/_authenticated/profile";
const ProfileComponent = (ProfileRoute as any).options.component as React.ComponentType;

const MATERIAL = {
  encrypted_private_key: "epk",
  kdf_salt: "salt",
  kdf_ops: 3,
  kdf_mem: 67108864,
  nonce: "n",
};

function resetStore() {
  useE2ESession.setState({
    publicKey: null,
    privateKey: null,
    isUnlocked: false,
    needsBootstrap: false,
    material: null,
    hydrated: true,
    status: "loading",
    refreshing: false,
  });
}

const CHANNEL = "e2e-key-status.v1";

describe("cross-tab key-status propagation — an already-open profile page updates without reload", () => {
  let receiver: BroadcastChannel;
  let sender: BroadcastChannel;
  let teardownSync: () => void = () => {};

  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    cleanup();
    // "Tab A" (this tab) uses `receiver` as its transport — this is what the
    // profile page's initKeyStatusCrossTabSync() subscribes to.
    receiver = new BroadcastChannel(CHANNEL);
    __setKeyStatusTransport(receiver);
    // "Tab B" (the other browser tab) publishes on its own channel of the
    // same name; BroadcastChannel guarantees the message is delivered to
    // every OTHER channel bound to the same name — including ours.
    sender = new BroadcastChannel(CHANNEL);
  });

  afterEach(() => {
    teardownSync();
    try { receiver.close(); } catch { /* ignore */ }
    try { sender.close(); } catch { /* ignore */ }
    __setKeyStatusTransport(null);
  });

  it("profile page mounted with status=not_issued flips to 'Locked' badge after a sibling tab issues a key", async () => {
    // Tab A: initial mount — the shell fetched key material and got nothing.
    getMaterialSpy.mockResolvedValue({ material: null, public_key: null });
    useE2ESession.getState().setMaterial(null, null);
    expect(useE2ESession.getState().status).toBe("not_issued");

    render(<ProfileComponent />);
    // Initial UI reflects "not_issued".
    expect(await screen.findByText(/not issued/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /enable encryption/i })).toBeTruthy();

    // Wire up cross-tab sync (normally done by the authenticated shell).
    teardownSync = initKeyStatusCrossTabSync();

    // Tab B has just finished bootstrap: server now has key material.
    // Simulate that by (a) making the next refresh return real material and
    // (b) posting the cross-tab ping the way Tab B's store would.
    getMaterialSpy.mockResolvedValue({ material: MATERIAL, public_key: "PUB_FROM_TAB_B" });

    await act(async () => {
      sender.postMessage({ reason: "bootstrap", seq: 1 });
      // Let the message loop and the awaited refreshStatus settle.
      await new Promise((r) => setTimeout(r, 20));
    });

    // The Locked badge is now visible without any reload / re-mount / user action.
    await waitFor(() => {
      expect(screen.getByText(/^locked$/i)).toBeTruthy();
    });
    expect(useE2ESession.getState().status).toBe("locked");
    expect(useE2ESession.getState().publicKey).toBe("PUB_FROM_TAB_B");
    expect(getMaterialSpy).toHaveBeenCalledTimes(1);
    // The button offered to the user updates too: "Unlock now" replaces
    // "Enable encryption" because the key already exists on the server.
    expect(screen.getByRole("button", { name: /unlock now/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /enable encryption/i })).toBeNull();
  });

  it("sibling tab signing out ('clear' broadcast) locks this tab immediately", async () => {
    // Tab A is fully unlocked with a key.
    getMaterialSpy.mockResolvedValue({ material: MATERIAL, public_key: "PUB" });
    useE2ESession.getState().setMaterial(MATERIAL as any, "PUB");
    // Simulate a completed unlock without touching the crypto helpers.
    useE2ESession.setState({
      privateKey: new Uint8Array([1, 2, 3]),
      isUnlocked: true,
      status: "ready",
    });

    render(<ProfileComponent />);
    expect(await screen.findByText(/^ready$/i)).toBeTruthy();

    teardownSync = initKeyStatusCrossTabSync();

    // Tab B signs out.
    await act(async () => {
      sender.postMessage({ reason: "clear", seq: 1 });
      await new Promise((r) => setTimeout(r, 20));
    });

    // Tab A's badge and store state reflect the lock — no server round-trip needed.
    await waitFor(() => {
      expect(useE2ESession.getState().status).toBe("not_issued");
    });
    expect(useE2ESession.getState().isUnlocked).toBe(false);
    expect(useE2ESession.getState().privateKey).toBeNull();
    // refreshStatus must not run for a "clear" broadcast — the receiver
    // trusts the sibling's sign-out and locks immediately.
    expect(getMaterialSpy).not.toHaveBeenCalled();
  });
});
