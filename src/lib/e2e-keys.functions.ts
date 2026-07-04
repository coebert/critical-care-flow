import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";

// ---------------------------------------------------------------------------
// Key management for E2E-encrypted notes.
// The server never sees plaintext note bodies or unwrapped private keys —
// it only stores ciphertext + per-recipient wrapped content keys.
// ---------------------------------------------------------------------------

const b64 = z.string().min(1).max(20000);

export const publishUserKeys = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        public_key: b64,
        encrypted_private_key: b64,
        kdf_salt: b64,
        kdf_ops: z.number().int().min(1).max(20),
        kdf_mem: z.number().int().min(1024).max(2_147_483_647),
        nonce: b64,
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error: e1 } = await supabase
      .from("user_public_keys")
      .upsert(
        { user_id: userId, public_key: data.public_key } as any,
        { onConflict: "user_id" },
      );
    if (e1) throw safeError("e2e.publishPublic", e1, "Failed to publish public key.");
    const { error: e2 } = await supabase
      .from("user_private_key_material")
      .upsert(
        {
          user_id: userId,
          encrypted_private_key: data.encrypted_private_key,
          kdf_salt: data.kdf_salt,
          kdf_ops: data.kdf_ops,
          kdf_mem: data.kdf_mem,
          nonce: data.nonce,
        } as any,
        { onConflict: "user_id" },
      );
    if (e2) throw safeError("e2e.publishPrivate", e2, "Failed to store encrypted key.");
    return { ok: true };
  });

export const getMyPrivateKeyMaterial = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("user_private_key_material")
      .select("encrypted_private_key, kdf_salt, kdf_ops, kdf_mem, nonce")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw safeError("e2e.getPriv", error, "Failed to load encrypted key.");
    // Also fetch the matching public key so the client can pair them.
    const { data: pub } = await supabase
      .from("user_public_keys")
      .select("public_key")
      .eq("user_id", userId)
      .maybeSingle();
    return { material: data ?? null, public_key: pub?.public_key ?? null };
  });

export const getPublicKeyDirectory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    // Every clinician/admin who has published a public key is a recipient.
    const { data: roles, error: e1 } = await supabase
      .from("user_roles")
      .select("user_id, role")
      .in("role", ["admin", "clinician"]);
    if (e1) throw safeError("e2e.roles", e1, "Failed to load teammates.");
    const ids = Array.from(new Set((roles ?? []).map((r) => r.user_id)));
    if (!ids.length) return [];
    const { data: keys, error: e2 } = await supabase
      .from("user_public_keys")
      .select("user_id, public_key")
      .in("user_id", ids);
    if (e2) throw safeError("e2e.keys", e2, "Failed to load public keys.");
    const { data: profs } = await supabase
      .from("profiles")
      .select("id, full_name")
      .in("id", ids);
    const nameOf = new Map((profs ?? []).map((p: any) => [p.id, p.full_name]));
    const keyOf = new Map((keys ?? []).map((k: any) => [k.user_id, k.public_key]));
    return ids.map((uid) => ({
      user_id: uid,
      full_name: nameOf.get(uid) ?? "Clinician",
      public_key: keyOf.get(uid) ?? null,
    }));
  });
