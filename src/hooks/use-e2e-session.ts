import { create } from "zustand";
import { unwrapPrivateKey, generateAndWrapKeypair, type PrivateKeyMaterial } from "@/lib/e2e-crypto";

// In-memory only — the unwrapped private key must NEVER touch storage.
interface E2EState {
  publicKey: string | null;
  privateKey: Uint8Array | null;
  isUnlocked: boolean;
  needsBootstrap: boolean; // no material stored yet
  material: PrivateKeyMaterial | null;
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
  clear: () => void;
}

export const useE2ESession = create<E2EState>((set, get) => ({
  publicKey: null,
  privateKey: null,
  isUnlocked: false,
  needsBootstrap: false,
  material: null,
  setMaterial: (material, publicKey) =>
    set({
      material,
      publicKey,
      needsBootstrap: !material || !publicKey,
      // Fresh material invalidates any prior unlock.
      privateKey: null,
      isUnlocked: false,
    }),
  unlock: async (password: string) => {
    const { material, publicKey } = get();
    if (!material || !publicKey) throw new Error("No encrypted key stored yet.");
    const priv = await unwrapPrivateKey(password, material);
    set({ privateKey: priv, isUnlocked: true });
  },
  bootstrap: async (password, publish) => {
    const { keypair, material } = await generateAndWrapKeypair(password);
    await publish({ public_key: keypair.publicKey, ...material });
    // Decode the private key we just generated so we can use it in-session.
    const priv = await unwrapPrivateKey(password, material);
    set({
      publicKey: keypair.publicKey,
      privateKey: priv,
      isUnlocked: true,
      needsBootstrap: false,
      material,
    });
  },
  clear: () =>
    set({
      publicKey: null,
      privateKey: null,
      isUnlocked: false,
      needsBootstrap: false,
      material: null,
    }),
}));
