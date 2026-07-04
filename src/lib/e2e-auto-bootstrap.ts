import { generateAndWrapKeypair } from "@/lib/e2e-crypto";
import { getMyPrivateKeyMaterial, publishUserKeys } from "@/lib/e2e-keys.functions";

/**
 * Automatically issue a recipient keypair for the signed-in user if none
 * exists yet. Safe to call after every password sign-in — it's a no-op when
 * the user already has published key material. Non-fatal on failure: the
 * user can still sign in and will be prompted to enable encryption later.
 *
 * The wrapping password is derived from the user's login password, so this
 * only works from a code path where the password is available in memory
 * (password sign-in, first-admin setup, password reset).
 */
export async function ensureRecipientKey(password: string): Promise<void> {
  try {
    const existing: any = await getMyPrivateKeyMaterial({ data: undefined as any });
    if (existing?.material && existing?.public_key) return; // already issued
    const { keypair, material } = await generateAndWrapKeypair(password);
    await publishUserKeys({
      data: {
        public_key: keypair.publicKey,
        encrypted_private_key: material.encrypted_private_key,
        kdf_salt: material.kdf_salt,
        kdf_ops: material.kdf_ops,
        kdf_mem: material.kdf_mem,
        nonce: material.nonce,
      },
    });
  } catch (err) {
    // Non-fatal — user can still complete the enable-encryption flow manually.
    console.warn("[e2e] auto-bootstrap skipped:", err);
  }
}
