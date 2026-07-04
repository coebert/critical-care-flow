import { describe, it, expect, vi } from "vitest";
import { ensureRecipientKeyImpl, type EnsureKeyDeps } from "./e2e-auto-bootstrap";

const PUB = "PUBLIC_KEY_B64";
const MATERIAL = {
  encrypted_private_key: "epk",
  kdf_salt: "salt",
  kdf_ops: 3,
  kdf_mem: 67108864,
  nonce: "n",
};

function makeDeps(overrides: Partial<EnsureKeyDeps> = {}): EnsureKeyDeps {
  return {
    fetchMaterial: vi.fn().mockResolvedValue({ material: null, public_key: null }),
    generate: vi.fn().mockResolvedValue({
      keypair: { publicKey: PUB },
      material: MATERIAL,
    }),
    publish: vi.fn().mockResolvedValue({ ok: true }),
    onWarn: vi.fn(),
    // Keep tests fast — no real waiting.
    baseDelayMs: 0,
    retries: 2,
    ...overrides,
  };
}

describe("ensureRecipientKeyImpl — auto-issue on sign-in, setup, and password reset", () => {
  it("issues a new keypair when none exists (sign-in path)", async () => {
    const deps = makeDeps();
    const outcome = await ensureRecipientKeyImpl("pw1", deps);

    expect(outcome).toEqual({ kind: "issued" });
    expect(deps.generate).toHaveBeenCalledWith("pw1");
    expect(deps.publish).toHaveBeenCalledTimes(1);
    expect(deps.publish).toHaveBeenCalledWith({
      public_key: PUB,
      ...MATERIAL,
    });
  });

  it("issues on first-admin setup exactly the same way (uses the setup password)", async () => {
    const deps = makeDeps();
    const outcome = await ensureRecipientKeyImpl("setup-pw", deps);

    expect(outcome.kind).toBe("issued");
    expect(deps.generate).toHaveBeenCalledWith("setup-pw");
  });

  it("issues after a password reset using the new password as the wrapping key", async () => {
    const deps = makeDeps();
    const outcome = await ensureRecipientKeyImpl("brand-new-pw", deps);

    expect(outcome.kind).toBe("issued");
    expect(deps.generate).toHaveBeenCalledWith("brand-new-pw");
    expect(deps.publish).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: does nothing when a keypair is already issued", async () => {
    const deps = makeDeps({
      fetchMaterial: vi.fn().mockResolvedValue({ material: MATERIAL, public_key: PUB }),
    });

    const outcome = await ensureRecipientKeyImpl("pw", deps);

    expect(outcome).toEqual({ kind: "already_issued" });
    expect(deps.generate).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it("treats a partial existing record (public key only, no material) as not issued", async () => {
    const deps = makeDeps({
      fetchMaterial: vi.fn().mockResolvedValue({ material: null, public_key: PUB }),
    });
    const outcome = await ensureRecipientKeyImpl("pw", deps);
    expect(outcome.kind).toBe("issued");
    expect(deps.publish).toHaveBeenCalledTimes(1);
  });
});

describe("ensureRecipientKeyImpl — failures are retried safely", () => {
  it("retries a transient network failure on publish, then succeeds", async () => {
    const publish = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockResolvedValueOnce({ ok: true });
    const deps = makeDeps({ publish });

    const outcome = await ensureRecipientKeyImpl("pw", deps);

    expect(outcome).toEqual({ kind: "issued" });
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("retries a transient failure on fetchMaterial before deciding what to do", async () => {
    const fetchMaterial = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("failed to fetch"))
      .mockResolvedValueOnce({ material: MATERIAL, public_key: PUB });
    const deps = makeDeps({ fetchMaterial });

    const outcome = await ensureRecipientKeyImpl("pw", deps);

    expect(fetchMaterial).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({ kind: "already_issued" });
  });

  it("gives up after exhausting retries on a persistent transient error and skips (never throws)", async () => {
    const publish = vi.fn().mockRejectedValue(new TypeError("Load failed"));
    const deps = makeDeps({ publish, retries: 2 });

    const outcome = await ensureRecipientKeyImpl("pw", deps);

    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") expect(outcome.reason).toBe("publish_failed");
    // retries: 2 → total attempts = 3
    expect(publish).toHaveBeenCalledTimes(3);
    expect(deps.onWarn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a permanent (non-transient) publish error — fails once and skips", async () => {
    const permanent = Object.assign(new Error("Forbidden"), { status: 403 });
    const publish = vi.fn().mockRejectedValue(permanent);
    const deps = makeDeps({ publish });

    const outcome = await ensureRecipientKeyImpl("pw", deps);

    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") expect(outcome.reason).toBe("publish_failed");
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("classifies a fetch failure vs a publish failure so callers can tell them apart", async () => {
    const fetchMaterial = vi.fn().mockRejectedValue(new TypeError("Load failed"));
    const deps = makeDeps({ fetchMaterial });

    const outcome = await ensureRecipientKeyImpl("pw", deps);

    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") expect(outcome.reason).toBe("fetch_failed");
    // generate/publish never run when we couldn't even confirm existing state.
    expect(deps.generate).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it("skips (never throws) when keypair generation itself fails", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("sodium not available"));
    const deps = makeDeps({ generate });

    const outcome = await ensureRecipientKeyImpl("pw", deps);

    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") expect(outcome.reason).toBe("generate_failed");
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it("a failed attempt is safe to retry on the next sign-in (idempotency after skip)", async () => {
    // First call: publish fails permanently → skipped.
    const publish = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("Server down"), { status: 500 }))
      .mockRejectedValueOnce(Object.assign(new Error("Server down"), { status: 500 }))
      .mockRejectedValueOnce(Object.assign(new Error("Server down"), { status: 500 }))
      .mockResolvedValueOnce({ ok: true }); // eventual success on the next sign-in
    const fetchMaterial = vi
      .fn()
      // First call sees no material.
      .mockResolvedValueOnce({ material: null, public_key: null })
      // Second call still sees no material (previous publish never succeeded).
      .mockResolvedValueOnce({ material: null, public_key: null });

    const deps = makeDeps({ publish, fetchMaterial });

    const first = await ensureRecipientKeyImpl("pw", deps);
    expect(first.kind).toBe("skipped");

    // Simulate a second sign-in re-invoking the flow.
    const second = await ensureRecipientKeyImpl("pw", deps);
    expect(second.kind).toBe("issued");
    // 3 failed + 1 successful publish across both invocations.
    expect(publish).toHaveBeenCalledTimes(4);
  });
});
