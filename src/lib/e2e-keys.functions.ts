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

// Recipient-key lifecycle events written to public.audit_log. The enum was
// extended in the accompanying migration so admins can review when each
// user's keypair was created, replaced, or unlocked in a browser session.
export type KeyLifecycleSource = "issue" | "enable" | "reissue";

async function writeKeyLifecycleAudit(
  userId: string,
  action: "issue" | "enable" | "unlock" | "reissue",
  publicKey: string | null,
) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // Never store the raw public key — a short fingerprint is enough to tell
  // two keys apart in the audit trail without giving an audit-log reader a
  // pointer to correlate against note ciphertext.
  const fingerprint = publicKey ? publicKey.slice(0, 16) : null;
  await supabaseAdmin.from("audit_log").insert({
    user_id: userId,
    action,
    entity: "user_keypair",
    entity_id: userId,
    diff: { source: action, public_key_fingerprint: fingerprint },
  } as any);
}

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
        // Distinguishes an automatic sign-in bootstrap ("issue") from a
        // user-driven bootstrap in the UI ("enable"). Defaults to "issue"
        // for backwards compatibility with older callers.
        source: z.enum(["issue", "enable"]).optional(),
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
    // Best-effort audit — a broken audit must not block the user from having
    // a working recipient key, so we log-and-swallow.
    try {
      await writeKeyLifecycleAudit(userId, data.source ?? "issue", data.public_key);
    } catch (auditErr) {
      console.error("e2e.publish.audit failed", auditErr);
    }
    return { ok: true };
  });

// Called from the client whenever the recipient key transitions from
// locked → unlocked in a browser session (fresh password unwrap only —
// sessionStorage rehydration does NOT re-log, because that key was
// already audited when it was first unlocked).
export const logRecipientKeyUnlock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ public_key: b64.optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    try {
      await writeKeyLifecycleAudit(context.userId, "unlock", data.public_key ?? null);
    } catch (auditErr) {
      // Do not fail the unlock UX if the audit write fails.
      console.error("e2e.unlock.audit failed", auditErr);
    }
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

// ---------------------------------------------------------------------------
// Governance: re-issue a user's keypair.
// Destructive — anything encrypted to their OLD public key becomes
// unrecoverable for them. Governance checks enforced here:
//   1. The caller must be signed in (requireSupabaseAuth).
//   2. The caller must re-authenticate by supplying their current password.
//      We verify with a server-local publishable client's signInWithPassword,
//      so this survives a stolen session token that lacks the password.
//   3. Every re-issue writes an audit_log entry (entity: "user_keypair").
// ---------------------------------------------------------------------------
export const reissueRecipientKeypair = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        password: z.string().min(1).max(256),
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
    const { supabase, userId, claims } = context;
    const email = (claims as any)?.email as string | undefined;
    if (!email) {
      throw safeError("e2e.reissue.email", new Error("No email in session"),
        "Cannot re-issue keypair: no email associated with this account.");
    }

    // Re-authenticate the caller with the password they just typed. Uses a
    // fresh server-local publishable client so the current session isn't
    // touched. Wrong password → Supabase returns AuthApiError; we surface a
    // generic message so we don't leak which of email/password was wrong.
    const { createClient } = await import("@supabase/supabase-js");
    const verifier = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_PUBLISHABLE_KEY!,
      { auth: { storage: undefined, persistSession: false, autoRefreshToken: false } },
    );
    const { data: verified, error: verifyErr } = await verifier.auth.signInWithPassword({
      email,
      password: data.password,
    });
    if (verifyErr || verified?.user?.id !== userId) {
      throw new Error("Password confirmation failed. Please re-enter your password.");
    }
    // Best-effort: release the verification session immediately.
    try { await verifier.auth.signOut(); } catch { /* ignore */ }

    // Write the audit entry BEFORE mutating so a failed audit doesn't leave a
    // silent key change on record.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error: auditErr } = await supabaseAdmin.from("audit_log").insert({
      user_id: userId,
      action: "reissue",
      entity: "user_keypair",
      entity_id: userId,
      diff: { public_key_fingerprint: data.public_key.slice(0, 16) },
    } as any);
    if (auditErr) throw safeError("e2e.reissue.audit", auditErr, "Failed to record re-issue.");

    const { error: e1 } = await supabase
      .from("user_public_keys")
      .upsert(
        { user_id: userId, public_key: data.public_key } as any,
        { onConflict: "user_id" },
      );
    if (e1) throw safeError("e2e.reissue.pub", e1, "Failed to publish new public key.");

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
    if (e2) throw safeError("e2e.reissue.priv", e2, "Failed to store new encrypted key.");

    return { ok: true };
  });
