import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock crypto so we don't need real libsodium in the test — the profile
// refresh contract is about state transitions after unlock/enable, not
// about whether the ciphertext round-trips.
vi.mock("@/lib/e2e-crypto", () => {
  return {
    sodium: async () => ({
      to_base64: (u: Uint8Array) => Buffer.from(u).toString("base64"),
      from_base64: (s: string) => new Uint8Array(Buffer.from(s, "base64")),
      base64_variants: { ORIGINAL: 1 },
    }),
    unwrapPrivateKey: vi.fn(async () => new Uint8Array([1, 2, 3])),
    generateAndWrapKeypair: vi.fn(async () => ({
      keypair: { publicKey: "NEW_PUB_KEY_B64" },
      material: {
        encrypted_private_key: "epk",
        kdf_salt: "salt",
        kdf_ops: 3,
        kdf_mem: 67108864,
        nonce: "n",
      },
    })),
  };
});

// The unlock audit is fire-and-forget — stub it so the test doesn't hit the
// server-fn runtime.
vi.mock("@/lib/e2e-keys.functions", () => ({
  logRecipientKeyUnlock: vi.fn(async () => ({ ok: true })),
  getMyPrivateKeyMaterial: vi.fn(),
  publishUserKeys: vi.fn(),
  reissueRecipientKeypair: vi.fn(),
}));

import { useE2ESession } from "@/hooks/use-e2e-session";

// This mirrors the exact status-derivation the profile page performs inside
// its `refreshKeyStatus` callback. If the profile page's contract changes,
// this helper must change with it — the test guards the *observable*
// behaviour a user sees on that screen.
type Status = "loading" | "ready" | "locked" | "not_issued";
function deriveStatusFromStore(
  fetched: { material: unknown | null; public_key: string | null },
): Status {
  useE2ESession
    .getState()
    .setMaterial(fetched.material as any, fetched.public_key);
  const s = useE2ESession.getState();
  if (!fetched.material || !fetched.public_key) return "not_issued";
  return s.isUnlocked ? "ready" : "locked";
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
  });
  try {
    globalThis.sessionStorage?.clear?.();
  } catch {
    /* ignore */
  }
}

describe("profile page — real-time key status refresh after modal actions", () => {
  beforeEach(() => resetStore());

  it("shows 'locked' initially, then flips to 'ready' immediately after unlock (no reload)", async () => {
    // First render: server says a key is issued but nothing is unlocked yet.
    const before = deriveStatusFromStore({
      material: MATERIAL,
      public_key: "EXISTING_PUB",
    });
    expect(before).toBe("locked");

    // Simulate the E2EUnlockModal's success path: it calls
    // useE2ESession.unlock() then invokes onUnlocked (= refreshKeyStatus).
    await useE2ESession.getState().unlock("correct-password");

    // The onUnlocked callback re-fetches key material and re-derives status.
    // Server still returns the same key material — the ONLY thing that
    // changed is the unlocked flag in the store.
    const afterUnlock = deriveStatusFromStore({
      material: MATERIAL,
      public_key: "EXISTING_PUB",
    });
    expect(afterUnlock).toBe("ready");
    expect(useE2ESession.getState().isUnlocked).toBe(true);
    expect(useE2ESession.getState().publicKey).toBe("EXISTING_PUB");
  });

  it("shows 'not_issued' initially, then flips to 'ready' immediately after enabling encryption from the modal", async () => {
    // No key on the server yet.
    const before = deriveStatusFromStore({ material: null, public_key: null });
    expect(before).toBe("not_issued");
    expect(useE2ESession.getState().needsBootstrap).toBe(true);

    // Simulate the modal's bootstrap path (user-driven "Enable encryption").
    const publish = vi.fn().mockResolvedValue({ ok: true });
    await useE2ESession.getState().bootstrap("brand-new-pw", publish);
    expect(publish).toHaveBeenCalledTimes(1);

    // After bootstrap the modal calls onUnlocked → refreshKeyStatus, which
    // re-fetches from the server. Simulate the server now returning the
    // freshly-published key material.
    const afterEnable = deriveStatusFromStore({
      material: MATERIAL,
      public_key: "NEW_PUB_KEY_B64",
    });
    expect(afterEnable).toBe("ready");
    expect(useE2ESession.getState().isUnlocked).toBe(true);
    expect(useE2ESession.getState().publicKey).toBe("NEW_PUB_KEY_B64");
    expect(useE2ESession.getState().needsBootstrap).toBe(false);
  });

  it("keeps 'ready' — not 'locked' — when refreshKeyStatus re-runs after unlock (setMaterial must not clear an in-tab session for the same key)", async () => {
    // A stale mount used to reset unlocked state whenever setMaterial ran,
    // making the badge briefly flip back to 'locked'. Guard against that.
    deriveStatusFromStore({ material: MATERIAL, public_key: "SAME_PUB" });
    await useE2ESession.getState().unlock("pw");
    expect(useE2ESession.getState().isUnlocked).toBe(true);

    // Second refresh with the same server-side key must preserve unlocked.
    const status = deriveStatusFromStore({
      material: MATERIAL,
      public_key: "SAME_PUB",
    });
    expect(status).toBe("ready");
  });
});
