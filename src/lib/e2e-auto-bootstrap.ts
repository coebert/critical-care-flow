import { generateAndWrapKeypair } from "@/lib/e2e-crypto";
import { getMyPrivateKeyMaterial, publishUserKeys } from "@/lib/e2e-keys.functions";
import { retryWithBackoff, isTransientAuthError } from "@/lib/retry";
import { useE2ESession } from "@/hooks/use-e2e-session";

export interface EnsureKeyDeps {
  fetchMaterial: () => Promise<{
    material: unknown | null;
    public_key: string | null;
  }>;
  generate: (password: string) => Promise<{
    keypair: { publicKey: string };
    material: {
      encrypted_private_key: string;
      kdf_salt: string;
      kdf_ops: number;
      kdf_mem: number;
      nonce: string;
    };
  }>;
  publish: (m: {
    public_key: string;
    encrypted_private_key: string;
    kdf_salt: string;
    kdf_ops: number;
    kdf_mem: number;
    nonce: string;
  }) => Promise<unknown>;
  onWarn?: (err: unknown) => void;
  retries?: number;
  baseDelayMs?: number;
}

export type EnsureKeyOutcome =
  | { kind: "already_issued" }
  | { kind: "issued" }
  | { kind: "skipped"; reason: "fetch_failed" | "publish_failed" | "generate_failed"; error: unknown };

/**
 * Pure orchestrator for the auto-issue flow. Extracted from `ensureRecipientKey`
 * so tests can drive every branch (already issued, freshly issued, transient
 * failure retried, permanent failure skipped) with mock deps.
 *
 * Contract:
 *  - If the user already has published material, return `already_issued`
 *    without generating or publishing anything (idempotent).
 *  - If material is missing, generate a new keypair and publish it. Publish
 *    is wrapped in retry-with-backoff for transient errors.
 *  - Any failure returns a `skipped` outcome — never throws — so the
 *    calling auth flow (sign-in, setup, reset) continues uninterrupted.
 */
export async function ensureRecipientKeyImpl(
  password: string,
  deps: EnsureKeyDeps,
): Promise<EnsureKeyOutcome> {
  const retries = deps.retries ?? 2;
  const baseDelayMs = deps.baseDelayMs ?? 100;

  let existing: { material: unknown | null; public_key: string | null };
  try {
    existing = await retryWithBackoff(() => deps.fetchMaterial(), {
      retries,
      baseDelayMs,
      shouldRetry: isTransientAuthError,
    });
  } catch (err) {
    deps.onWarn?.(err);
    return { kind: "skipped", reason: "fetch_failed", error: err };
  }

  if (existing?.material && existing?.public_key) {
    return { kind: "already_issued" };
  }

  let generated: Awaited<ReturnType<EnsureKeyDeps["generate"]>>;
  try {
    generated = await deps.generate(password);
  } catch (err) {
    deps.onWarn?.(err);
    return { kind: "skipped", reason: "generate_failed", error: err };
  }

  try {
    await retryWithBackoff(
      () =>
        deps.publish({
          public_key: generated.keypair.publicKey,
          encrypted_private_key: generated.material.encrypted_private_key,
          kdf_salt: generated.material.kdf_salt,
          kdf_ops: generated.material.kdf_ops,
          kdf_mem: generated.material.kdf_mem,
          nonce: generated.material.nonce,
        }),
      { retries, baseDelayMs, shouldRetry: isTransientAuthError },
    );
    return { kind: "issued" };
  } catch (err) {
    deps.onWarn?.(err);
    return { kind: "skipped", reason: "publish_failed", error: err };
  }
}

/**
 * Production wrapper: wires the real server functions and crypto helpers into
 * `ensureRecipientKeyImpl`. Safe to call after every password sign-in — it's
 * a no-op when the user already has published key material and never throws.
 *
 * The wrapping password is derived from the user's login password, so this
 * only works from a code path where the password is available in memory
 * (password sign-in, first-admin setup, password reset).
 */
export async function ensureRecipientKey(password: string): Promise<EnsureKeyOutcome> {
  return ensureRecipientKeyImpl(password, {
    fetchMaterial: async () => {
      const res: any = await getMyPrivateKeyMaterial({ data: undefined as any });
      return { material: res?.material ?? null, public_key: res?.public_key ?? null };
    },
    generate: (pw) => generateAndWrapKeypair(pw),
    publish: (m) => publishUserKeys({ data: m }),
    onWarn: (err) => console.warn("[e2e] auto-bootstrap skipped:", err),
  });
}
