// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Stub crypto + audit + server fns so the modal can render without hitting
// the real Worker runtime. Cancelling the modal should touch NONE of these
// mocks — that's the whole invariant this file guards.
const { publishSpy, unwrapSpy, generateSpy, logUnlockSpy, getMaterialSpy } = vi.hoisted(() => ({
  publishSpy: vi.fn(async () => ({ ok: true })),
  unwrapSpy: vi.fn(async () => new Uint8Array([1, 2, 3])),
  generateSpy: vi.fn(async () => ({
    keypair: { publicKey: "NEW_PUB" },
    material: {
      encrypted_private_key: "epk",
      kdf_salt: "salt",
      kdf_ops: 3,
      kdf_mem: 67108864,
      nonce: "n",
    },
  })),
  logUnlockSpy: vi.fn(async () => ({ ok: true })),
  getMaterialSpy: vi.fn(async () => ({ material: null, public_key: null })),
}));

vi.mock("@/lib/e2e-crypto", () => ({
  sodium: async () => ({
    to_base64: (u: Uint8Array) => Buffer.from(u).toString("base64"),
    from_base64: (s: string) => new Uint8Array(Buffer.from(s, "base64")),
    base64_variants: { ORIGINAL: 1 },
  }),
  unwrapPrivateKey: unwrapSpy,
  generateAndWrapKeypair: generateSpy,
}));

vi.mock("@/lib/e2e-keys.functions", () => ({
  logRecipientKeyUnlock: logUnlockSpy,
  getMyPrivateKeyMaterial: getMaterialSpy,
  publishUserKeys: publishSpy,
  reissueRecipientKeypair: vi.fn(),
}));

// `useServerFn` normally wraps a createServerFn call — in a jsdom test we
// just want the raw function so `publish(...)` inside the modal executes
// our spy directly.
vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));

// sonner toast: no-op in tests.
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { E2EUnlockModal } from "@/components/e2e-unlock-modal";
import { useE2ESession } from "@/hooks/use-e2e-session";

const EXISTING_MATERIAL = {
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

function snapshotStore() {
  const s = useE2ESession.getState();
  return {
    status: s.status,
    isUnlocked: s.isUnlocked,
    publicKey: s.publicKey,
    material: s.material,
    needsBootstrap: s.needsBootstrap,
  };
}

function Harness({
  onUnlocked,
  onOpenChange,
}: {
  onUnlocked: () => void;
  onOpenChange: (v: boolean) => void;
}) {
  return (
    <E2EUnlockModal
      open={true}
      onOpenChange={onOpenChange}
      onUnlocked={onUnlocked}
    />
  );
}

describe("E2EUnlockModal — cancelling must not mutate global key status or queue a refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    cleanup();
  });

  it("cancelling the unlock modal (existing key, status=locked) leaves the global status unchanged and does NOT call onUnlocked / refreshStatus / unlock", async () => {
    // Simulate the shell having already loaded key material for this user —
    // the profile shows a "Locked" badge and offers "Unlock now".
    useE2ESession.getState().setMaterial(EXISTING_MATERIAL as any, "EXISTING_PUB");
    expect(useE2ESession.getState().status).toBe("locked");
    const before = snapshotStore();

    const onUnlocked = vi.fn();
    const onOpenChange = vi.fn();
    const refreshSpy = vi.spyOn(useE2ESession.getState(), "refreshStatus");

    render(<Harness onUnlocked={onUnlocked} onOpenChange={onOpenChange} />);
    // Sanity: this is the unlock flow, not the bootstrap flow.
    expect(screen.getByRole("heading", { name: /unlock encrypted notes/i })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    // The modal asked the parent to close — nothing else.
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onUnlocked).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(unwrapSpy).not.toHaveBeenCalled();
    expect(logUnlockSpy).not.toHaveBeenCalled();
    // Global store is byte-for-byte the same as before opening the modal.
    expect(snapshotStore()).toEqual(before);
  });

  it("cancelling the enable-encryption modal (no key yet, status=not_issued) leaves the global status unchanged and does NOT call onUnlocked / refreshStatus / publish / generate", async () => {
    // Simulate the shell having loaded and found no key for this user.
    useE2ESession.getState().setMaterial(null, null);
    expect(useE2ESession.getState().status).toBe("not_issued");
    expect(useE2ESession.getState().needsBootstrap).toBe(true);
    const before = snapshotStore();

    const onUnlocked = vi.fn();
    const onOpenChange = vi.fn();
    const refreshSpy = vi.spyOn(useE2ESession.getState(), "refreshStatus");

    render(<Harness onUnlocked={onUnlocked} onOpenChange={onOpenChange} />);
    // Sanity: this is the bootstrap flow.
    expect(screen.getByRole("heading", { name: /enable end-to-end encryption/i })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onUnlocked).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(generateSpy).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
    expect(snapshotStore()).toEqual(before);
  });

  it("typing a password and then cancelling still does not submit — no publish, no unlock, no onUnlocked", async () => {
    // A user can start typing then change their mind. Nothing they typed
    // should reach the server or the crypto helpers.
    useE2ESession.getState().setMaterial(EXISTING_MATERIAL as any, "EXISTING_PUB");
    const before = snapshotStore();

    const onUnlocked = vi.fn();
    const onOpenChange = vi.fn();

    render(<Harness onUnlocked={onUnlocked} onOpenChange={onOpenChange} />);
    await userEvent.type(screen.getByLabelText(/^password$/i), "hunter2!!");
    await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(onUnlocked).not.toHaveBeenCalled();
    expect(unwrapSpy).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
    expect(snapshotStore()).toEqual(before);
  });
});
