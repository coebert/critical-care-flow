// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { publishSpy, unwrapSpy, generateSpy, logUnlockSpy, getMaterialSpy } = vi.hoisted(() => ({
  publishSpy: vi.fn(),
  unwrapSpy: vi.fn(),
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

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));

const { toastSuccess } = vi.hoisted(() => ({ toastSuccess: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: vi.fn() },
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

describe("E2EUnlockModal — failed unlock/enable keeps status locked and surfaces the error", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    cleanup();
  });

  it("wrong password → status stays 'locked', modal shows a wrong-password error, onUnlocked never fires", async () => {
    // Server-side key material is present; user is locked out until they
    // supply the correct password to unwrap the private key.
    useE2ESession.getState().setMaterial(EXISTING_MATERIAL as any, "EXISTING_PUB");
    expect(useE2ESession.getState().status).toBe("locked");
    const before = snapshotStore();

    unwrapSpy.mockRejectedValueOnce(new Error("crypto_secretbox_open failed"));

    const onUnlocked = vi.fn();
    const onOpenChange = vi.fn();
    const refreshSpy = vi.spyOn(useE2ESession.getState(), "refreshStatus");

    render(
      <E2EUnlockModal open={true} onOpenChange={onOpenChange} onUnlocked={onUnlocked} />,
    );
    await userEvent.type(screen.getByLabelText(/^password$/i), "wrong-pw");
    await userEvent.click(screen.getByRole("button", { name: /^unlock$/i }));

    // Actionable, user-friendly error is shown in an alert.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/incorrect password/i);
    expect(screen.getByText(/couldn't unlock/i)).toBeTruthy();
    // Submit button flips to a "Try again" affordance rather than staying "Unlock".
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();

    // Failure path must NOT touch global status, close the modal, or run
    // any of the post-success side effects.
    expect(unwrapSpy).toHaveBeenCalledTimes(1);
    expect(onUnlocked).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(logUnlockSpy).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(snapshotStore()).toEqual(before);
    expect(useE2ESession.getState().status).toBe("locked");
    expect(useE2ESession.getState().isUnlocked).toBe(false);
  });

  it("network failure on publish during enable → status stays 'not_issued', modal shows a network error, onUnlocked never fires", async () => {
    // No key issued yet — modal is in bootstrap (Enable encryption) mode.
    useE2ESession.getState().setMaterial(null, null);
    expect(useE2ESession.getState().status).toBe("not_issued");
    expect(useE2ESession.getState().needsBootstrap).toBe(true);
    const before = snapshotStore();

    publishSpy.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const onUnlocked = vi.fn();
    const onOpenChange = vi.fn();
    const refreshSpy = vi.spyOn(useE2ESession.getState(), "refreshStatus");

    render(
      <E2EUnlockModal open={true} onOpenChange={onOpenChange} onUnlocked={onUnlocked} />,
    );
    await userEvent.type(screen.getByLabelText(/^password$/i), "brand-new-pw");
    await userEvent.type(screen.getByLabelText(/^confirm password$/i), "brand-new-pw");
    await userEvent.click(screen.getByRole("button", { name: /enable encryption/i }));

    await waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(1));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/couldn't reach the server|network/i);
    expect(screen.getByText(/couldn't enable encryption/i)).toBeTruthy();

    // The generate step ran (we needed a candidate keypair before publishing)
    // but nothing that changes global state should have taken effect.
    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(unwrapSpy).not.toHaveBeenCalled();
    expect(onUnlocked).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(snapshotStore()).toEqual(before);
    expect(useE2ESession.getState().status).toBe("not_issued");
    expect(useE2ESession.getState().isUnlocked).toBe(false);
    expect(useE2ESession.getState().publicKey).toBeNull();
  });

  it("second wrong-password attempt increments the attempt counter in the alert while keeping status locked", async () => {
    useE2ESession.getState().setMaterial(EXISTING_MATERIAL as any, "EXISTING_PUB");
    const before = snapshotStore();

    unwrapSpy.mockRejectedValue(new Error("crypto_secretbox_open failed"));

    render(
      <E2EUnlockModal open={true} onOpenChange={vi.fn()} onUnlocked={vi.fn()} />,
    );

    await userEvent.type(screen.getByLabelText(/^password$/i), "nope");
    await userEvent.click(screen.getByRole("button", { name: /^unlock$/i }));
    await screen.findByRole("alert");

    await userEvent.clear(screen.getByLabelText(/^password$/i));
    await userEvent.type(screen.getByLabelText(/^password$/i), "still-nope");
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => {
      const alertText = screen.getByRole("alert").textContent ?? "";
      expect(alertText).toMatch(/attempt 2/i);
    });

    expect(unwrapSpy).toHaveBeenCalledTimes(2);
    expect(snapshotStore()).toEqual(before);
    expect(useE2ESession.getState().status).toBe("locked");
  });
});
