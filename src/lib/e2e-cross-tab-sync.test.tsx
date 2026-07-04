// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";

// Node's built-in BroadcastChannel is process-scoped and cross-realm, which
// is exactly what we want: two independent channels in the same test can
// stand in for two browser tabs. We do NOT stub it — we exercise the real
// transport end-to-end.

const { getMaterialSpy } = vi.hoisted(() => ({ getMaterialSpy: vi.fn() }));

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

import {
  useE2ESession,
  useKeyStatus,
  initKeyStatusCrossTabSync,
  __setKeyStatusTransport,
} from "@/hooks/use-e2e-session";

/**
 * Minimal stand-in for the profile page's badge+CTA area. Any authenticated
 * page in another tab uses the same `useKeyStatus()` selector, so this is a
 * faithful proxy for "the profile page is already mounted in another tab
 * and must update without a reload". Avoiding the real route component here
 * keeps the test focused on the cross-tab wiring rather than router setup.
 */
function KeyStatusView() {
  const status = useKeyStatus();
  const pub = useE2ESession((s) => s.publicKey);
  return (
    <div>
      <div data-testid="badge">{status}</div>
      {status === "not_issued" && <button>Enable encryption</button>}
      {status === "locked" && <button>Unlock now</button>}
      {status === "ready" && pub && <div data-testid="fp">{pub}</div>}
    </div>
  );
}

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

describe("cross-tab key-status propagation — an already-open page updates without reload", () => {
  let receiver: BroadcastChannel;
  let sender: BroadcastChannel;
  let teardownSync: () => void = () => {};

  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    cleanup();
    // "Tab A" (this tab): receiver is what initKeyStatusCrossTabSync listens on.
    receiver = new BroadcastChannel(CHANNEL);
    __setKeyStatusTransport(receiver);
    // "Tab B" (the other browser tab): posts on its own channel of the same
    // name. BroadcastChannel delivers to every OTHER channel of that name
    // — including ours — so this really does simulate a sibling tab.
    sender = new BroadcastChannel(CHANNEL);
  });

  afterEach(() => {
    teardownSync();
    try { receiver.close(); } catch { /* ignore */ }
    try { sender.close(); } catch { /* ignore */ }
    __setKeyStatusTransport(null);
  });

  it("badge flips from 'not_issued' → 'locked' after a sibling tab issues a key, with no reload", async () => {
    // Tab A: initial mount — the shell fetched key material and got nothing.
    useE2ESession.getState().setMaterial(null, null);
    expect(useE2ESession.getState().status).toBe("not_issued");

    render(<KeyStatusView />);
    expect(screen.getByTestId("badge").textContent).toBe("not_issued");
    expect(screen.getByRole("button", { name: /enable encryption/i })).toBeTruthy();

    teardownSync = initKeyStatusCrossTabSync();

    // Tab B has just finished bootstrap: server now has key material.
    // Prime the refresh response and post the cross-tab ping the way Tab B
    // would after its own bootstrap.
    getMaterialSpy.mockResolvedValue({ material: MATERIAL, public_key: "PUB_FROM_TAB_B" });

    await act(async () => {
      sender.postMessage({ reason: "bootstrap", seq: 1 });
      // Let the message loop + the awaited refreshStatus settle.
      await new Promise((r) => setTimeout(r, 20));
    });

    await waitFor(() => {
      expect(screen.getByTestId("badge").textContent).toBe("locked");
    });
    expect(useE2ESession.getState().publicKey).toBe("PUB_FROM_TAB_B");
    expect(getMaterialSpy).toHaveBeenCalledTimes(1);
    // The CTA updates too: "Unlock now" replaces "Enable encryption".
    expect(screen.getByRole("button", { name: /unlock now/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /enable encryption/i })).toBeNull();
  });

  it("sibling tab signing out ('clear' broadcast) locks this tab immediately without a server round-trip", async () => {
    // Tab A is fully unlocked with a key.
    useE2ESession.getState().setMaterial(MATERIAL as any, "PUB");
    useE2ESession.setState({
      privateKey: new Uint8Array([1, 2, 3]),
      isUnlocked: true,
      status: "ready",
    });

    render(<KeyStatusView />);
    expect(screen.getByTestId("badge").textContent).toBe("ready");

    teardownSync = initKeyStatusCrossTabSync();

    await act(async () => {
      sender.postMessage({ reason: "clear", seq: 1 });
      await new Promise((r) => setTimeout(r, 20));
    });

    await waitFor(() => {
      expect(useE2ESession.getState().status).toBe("not_issued");
    });
    expect(screen.getByTestId("badge").textContent).toBe("not_issued");
    expect(useE2ESession.getState().isUnlocked).toBe(false);
    expect(useE2ESession.getState().privateKey).toBeNull();
    // 'clear' propagation must NOT trigger a server round-trip — the receiver
    // trusts the sibling's sign-out and locks immediately.
    expect(getMaterialSpy).not.toHaveBeenCalled();
  });

  it("badge on this tab does not react to broadcasts posted on a DIFFERENT channel name (isolation)", async () => {
    useE2ESession.getState().setMaterial(null, null);
    render(<KeyStatusView />);
    teardownSync = initKeyStatusCrossTabSync();

    const wrongChannel = new BroadcastChannel("some-other-app-channel");
    getMaterialSpy.mockResolvedValue({ material: MATERIAL, public_key: "SHOULD_NOT_APPEAR" });

    await act(async () => {
      wrongChannel.postMessage({ reason: "bootstrap", seq: 1 });
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(screen.getByTestId("badge").textContent).toBe("not_issued");
    expect(getMaterialSpy).not.toHaveBeenCalled();
    wrongChannel.close();
  });
});
