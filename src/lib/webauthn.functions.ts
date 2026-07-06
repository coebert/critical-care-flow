import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "@/lib/safe-error";
// NOTE: @simplewebauthn/server transitively pulls in @peculiar/x509 →
// tsyringe → tslib decorator helpers. Evaluating that graph at module
// scope crashes on Cloudflare Workers with
//   TypeError: Cannot destructure property '__extends' of
//   '__toESM(...).default' as it is undefined
// during the SSR of any route whose bundle imports this file (auth page,
// passkey list, etc.), which takes down every request with a 500. We only
// need the runtime functions inside handler bodies, so lazy-load them
// there and keep only the erased `type` imports at module scope.
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";

async function loadWebauthnServer() {
  return await import("@simplewebauthn/server");
}

const RP_NAME = "SDH Critical Care";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function getRpAndOrigin(): { rpID: string; origin: string } {
  const req = getRequest();
  const origin =
    req?.headers.get("origin") ??
    (req?.url ? new URL(req.url).origin : "");
  if (!origin) throw new Error("Unable to determine request origin");
  const url = new URL(origin);
  return { rpID: url.hostname, origin };
}

// bytea → Uint8Array (backed by a fresh ArrayBuffer).
function pgByteaToBytes(v: string | Uint8Array): Uint8Array<ArrayBuffer> {
  let src: Uint8Array;
  if (v instanceof Uint8Array) {
    src = v;
  } else if (typeof v === "string" && v.startsWith("\\x")) {
    const hex = v.slice(2);
    src = new Uint8Array(hex.length / 2);
    for (let i = 0; i < src.length; i++) {
      src[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
  } else {
    src = new Uint8Array(Buffer.from(String(v), "base64"));
  }
  const buf = new ArrayBuffer(src.byteLength);
  const copy = new Uint8Array(buf);
  copy.set(src);
  return copy;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function lookupUserIdByEmail(supabaseAdmin: any, email: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.rpc("lookup_user_id_by_email", {
    _email: email,
  });
  if (error) return null;
  return (data as string | null) ?? null;
}

// ---------- Registration (authenticated) ----------

export const startPasskeyRegistration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { rpID } = getRpAndOrigin();

    const { data: userData } = await supabaseAdmin.auth.admin.getUserById(
      context.userId,
    );
    const email = userData?.user?.email ?? "user";

    const { data: existing } = await supabaseAdmin
      .from("webauthn_credentials")
      .select("credential_id, transports")
      .eq("user_id", context.userId);

    const excludeCredentials = (existing ?? []).map((c) => ({
      id: c.credential_id,
      transports: (c.transports ?? []) as AuthenticatorTransport[],
    }));

    const options = await (await loadWebauthnServer()).generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userID: new TextEncoder().encode(context.userId),
      userName: email,
      userDisplayName: email,
      attestationType: "none",
      excludeCredentials,
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
      },
    });

    await supabaseAdmin
      .from("webauthn_challenges")
      .delete()
      .eq("user_id", context.userId)
      .eq("kind", "registration");

    await supabaseAdmin.from("webauthn_challenges").insert({
      challenge: options.challenge,
      user_id: context.userId,
      kind: "registration",
    });

    return options;
  });

export const verifyPasskeyRegistration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { response: RegistrationResponseJSON; deviceLabel?: string }) =>
      input,
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { rpID, origin } = getRpAndOrigin();

    const { data: challengeRow } = await supabaseAdmin
      .from("webauthn_challenges")
      .select("id, challenge, expires_at")
      .eq("user_id", context.userId)
      .eq("kind", "registration")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!challengeRow) throw new Error("No pending registration challenge");
    if (new Date(challengeRow.expires_at) < new Date()) {
      await supabaseAdmin.from("webauthn_challenges").delete().eq("id", challengeRow.id);
      throw new Error("Registration challenge expired — please try again");
    }

    const verification = await (await loadWebauthnServer()).verifyRegistrationResponse({
      response: data.response,
      expectedChallenge: challengeRow.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });

    if (!verification.verified || !verification.registrationInfo) {
      throw new Error("Passkey registration could not be verified");
    }

    const { credential, aaguid } = verification.registrationInfo;

    // Defence-in-depth: the row we're about to insert MUST be owned by the
    // authenticated caller. context.userId comes from the verified bearer
    // token in requireSupabaseAuth; we still assert it explicitly and route
    // the insert through the RLS-scoped client so the ownership-bound
    // INSERT policy (auth.uid() = user_id) rejects any mismatch even if a
    // future refactor swaps the client.
    const ownerId = context.userId;
    if (!ownerId) throw new Error("Missing authenticated user for passkey registration");

    const row = {
      user_id: ownerId,
      credential_id: credential.id,
      public_key: `\\x${Buffer.from(credential.publicKey).toString("hex")}`,
      counter: credential.counter ?? 0,
      transports: credential.transports ?? [],
      device_label: data.deviceLabel?.slice(0, 100) ?? null,
      aaguid: aaguid ?? null,
    };
    if (row.user_id !== ownerId) {
      throw new Error("Passkey owner mismatch — refusing to register");
    }

    const { error: insertError } = await context.supabase
      .from("webauthn_credentials")
      .insert(row);

    if (insertError) throw safeError("webauthn.register", insertError, "Could not save passkey.");

    await supabaseAdmin.from("webauthn_challenges").delete().eq("id", challengeRow.id);


    return { ok: true };
  });

// ---------- Authentication (public) ----------

/**
 * Discriminated result so the client can distinguish "no passkey registered
 * for this account" from a successful challenge without inspecting message
 * strings. We intentionally accept the account-enumeration trade-off here —
 * the product spec requires routing users straight into enrolment.
 */
export type StartPasskeyAuthResult =
  | { status: "ok"; options: PublicKeyCredentialRequestOptionsJSON }
  | { status: "no_credentials"; code: "NO_PASSKEY_REGISTERED"; message: string };

export const startPasskeyAuthentication = createServerFn({ method: "POST" })
  .inputValidator((input: { email: string }) => input)
  .handler(async ({ data }): Promise<StartPasskeyAuthResult> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { rpID } = getRpAndOrigin();
    const email = normalizeEmail(data.email);

    const userId = await lookupUserIdByEmail(supabaseAdmin, email);
    const allowCredentials: { id: string; transports?: AuthenticatorTransport[] }[] = [];
    if (userId) {
      const { data: creds } = await supabaseAdmin
        .from("webauthn_credentials")
        .select("credential_id, transports")
        .eq("user_id", userId);
      for (const c of creds ?? []) {
        allowCredentials.push({
          id: c.credential_id,
          transports: (c.transports ?? []) as AuthenticatorTransport[],
        });
      }
    }

    if (allowCredentials.length === 0) {
      return {
        status: "no_credentials",
        code: "NO_PASSKEY_REGISTERED",
        message: "No passkey is registered for this account.",
      };
    }

    const options = await (await loadWebauthnServer()).generateAuthenticationOptions({
      rpID,
      userVerification: "required",
      allowCredentials,
    });

    await supabaseAdmin
      .from("webauthn_challenges")
      .delete()
      .eq("email_norm", email)
      .eq("kind", "authentication");

    await supabaseAdmin.from("webauthn_challenges").insert({
      challenge: options.challenge,
      email_norm: email,
      kind: "authentication",
    });

    return { status: "ok", options };
  });

export const verifyPasskeyAuthentication = createServerFn({ method: "POST" })
  .inputValidator(
    (input: { email: string; response: AuthenticationResponseJSON }) => input,
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { rpID, origin } = getRpAndOrigin();
    const email = normalizeEmail(data.email);

    const { data: beginData, error: beginErr } = await supabaseAdmin.rpc(
      "begin_auth_attempt",
      { _email: email, _attempt_type: "signin" },
    );
    if (beginErr) throw safeError("webauthn.auth", beginErr, "Sign-in check failed.");
    const begin = beginData as unknown as {
      locked: boolean;
      attempt_id: number | null;
      retry_after_seconds?: number;
    };
    if (begin?.locked) {
      const secs = begin.retry_after_seconds ?? 0;
      const mins = Math.max(1, Math.ceil(secs / 60));
      throw new Error(
        `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`,
      );
    }
    const attemptId = begin?.attempt_id ?? null;

    const finalize = async (success: boolean) => {
      if (attemptId != null) {
        try {
          await supabaseAdmin.rpc("finalize_auth_attempt", {
            _attempt_id: attemptId,
            _success: success,
          });
        } catch {
          /* non-fatal */
        }
      }
    };

    try {
      const { data: challengeRow } = await supabaseAdmin
        .from("webauthn_challenges")
        .select("id, challenge, expires_at")
        .eq("email_norm", email)
        .eq("kind", "authentication")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!challengeRow) throw new Error("No pending sign-in challenge");
      if (new Date(challengeRow.expires_at) < new Date()) {
        await supabaseAdmin.from("webauthn_challenges").delete().eq("id", challengeRow.id);
        throw new Error("Sign-in challenge expired — please try again");
      }

      const credentialId = data.response.id;
      const { data: credRow } = await supabaseAdmin
        .from("webauthn_credentials")
        .select("id, user_id, public_key, counter, transports")
        .eq("credential_id", credentialId)
        .maybeSingle();

      if (!credRow) throw new Error("Passkey not recognised for this account");

      const emailOwnerId = await lookupUserIdByEmail(supabaseAdmin, email);
      if (!emailOwnerId || emailOwnerId !== credRow.user_id) {
        throw new Error("Passkey does not belong to this account");
      }

      const publicKeyBytes = pgByteaToBytes(
        credRow.public_key as unknown as string,
      );

      const verification = await (await loadWebauthnServer()).verifyAuthenticationResponse({
        response: data.response,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: credentialId,
          publicKey: publicKeyBytes,
          counter: Number(credRow.counter ?? 0),
          transports: (credRow.transports ?? []) as AuthenticatorTransport[],
        },
      });

      if (!verification.verified) {
        throw new Error("Passkey verification failed");
      }

      // Counter/last-used bump: scope by BOTH row id AND the credential's
      // owning user_id so an admin-client update can never mutate a row
      // that doesn't belong to the account we just verified.
      await supabaseAdmin
        .from("webauthn_credentials")
        .update({
          counter: verification.authenticationInfo.newCounter,
          last_used_at: new Date().toISOString(),
        })
        .eq("id", credRow.id)
        .eq("user_id", credRow.user_id);


      await supabaseAdmin
        .from("webauthn_challenges")
        .delete()
        .eq("id", challengeRow.id);

      const { data: linkData, error: linkErr } =
        await supabaseAdmin.auth.admin.generateLink({
          type: "magiclink",
          email,
        });
      if (linkErr || !linkData?.properties?.hashed_token) {
        throw new Error("Could not issue session");
      }

      await finalize(true);
      return {
        email,
        token_hash: linkData.properties.hashed_token,
      };
    } catch (err) {
      await finalize(false);
      throw err;
    }
  });

// ---------- Manage passkeys (authenticated) ----------

export const listMyPasskeys = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("webauthn_credentials")
      .select("id, device_label, created_at, last_used_at, transports")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false });
    if (error) throw safeError("webauthn.list", error, "Could not load passkeys.");
    return { passkeys: data ?? [] };
  });

export const deleteMyPasskey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("webauthn_credentials")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw safeError("webauthn.delete", error, "Could not remove passkey.");
    return { ok: true };
  });
