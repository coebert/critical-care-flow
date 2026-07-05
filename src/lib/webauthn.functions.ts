import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

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

function b64uToBytes(b64u: string): Uint8Array {
  const b64 = b64u.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64u(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// bytea → base64url. Postgres returns bytea as `\x<hex>` via PostgREST JSON;
// convert to bytes then to base64url.
function pgByteaToBytes(v: string | Uint8Array): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string" && v.startsWith("\\x")) {
    const hex = v.slice(2);
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
  }
  // Fallback: assume already base64
  return b64uToBytes(String(v));
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

    const options = await generateRegistrationOptions({
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

    // Clean up stale challenges for this user before inserting a new one.
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

    const verification = await verifyRegistrationResponse({
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

    const { error: insertError } = await supabaseAdmin
      .from("webauthn_credentials")
      .insert({
        user_id: context.userId,
        credential_id: credential.id,
        public_key: `\\x${Buffer.from(credential.publicKey).toString("hex")}`,
        counter: credential.counter ?? 0,
        transports: credential.transports ?? [],
        device_label: data.deviceLabel?.slice(0, 100) ?? null,
        aaguid: aaguid ?? null,
      });

    if (insertError) throw new Error(insertError.message);

    await supabaseAdmin.from("webauthn_challenges").delete().eq("id", challengeRow.id);

    return { ok: true };
  });

// ---------- Authentication (public) ----------

export const startPasskeyAuthentication = createServerFn({ method: "POST" })
  .inputValidator((input: { email: string }) => input)
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { rpID } = getRpAndOrigin();
    const email = normalizeEmail(data.email);

    // Look up the user (privately). If not found, still return options with
    // an empty allowCredentials list to avoid account enumeration.
    let allowCredentials: { id: string; transports?: AuthenticatorTransport[] }[] = [];
    try {
      // Find user id by email via admin auth API; we don't expose whether it exists.
      const { data: page } = await supabaseAdmin.auth.admin.listUsers({
        page: 1,
        perPage: 1,
      });
      // listUsers doesn't filter server-side by email in older SDKs; use a query on profiles/auth.users via SQL.
      // Fall back to explicit lookup:
      void page;
      const { data: userRow } = await supabaseAdmin
        .rpc("has_role", { _user_id: "00000000-0000-0000-0000-000000000000", _role: "admin" })
        .then(() => ({ data: null }))
        .catch(() => ({ data: null }));
      void userRow;

      // Look up credentials by joining email → user_id. Use a raw select on auth.users via admin.
      const { data: users } = await supabaseAdmin
        .from("profiles")
        .select("id")
        .limit(1000); // profiles has id = auth user id
      const ids = (users ?? []).map((u) => u.id);
      // Fetch the auth user by email using generateLink probe would send email; instead use admin.getUserById is per-id.
      // Simplest: query webauthn_credentials joined via a view — but we don't have one.
      // Use SQL: find auth user id by email.
      const { data: authUser } = await supabaseAdmin
        .rpc("lookup_user_id_by_email", { _email: email })
        .then((r) => ({ data: r.data as string | null }))
        .catch(() => ({ data: null }));

      if (authUser && ids.includes(authUser)) {
        const { data: creds } = await supabaseAdmin
          .from("webauthn_credentials")
          .select("credential_id, transports")
          .eq("user_id", authUser);
        allowCredentials = (creds ?? []).map((c) => ({
          id: c.credential_id,
          transports: (c.transports ?? []) as AuthenticatorTransport[],
        }));
      }
    } catch {
      // ignore; return empty allowCredentials
    }

    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "required",
      allowCredentials,
    });

    // Store challenge keyed to email (single-use).
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

    return options;
  });

export const verifyPasskeyAuthentication = createServerFn({ method: "POST" })
  .inputValidator(
    (input: { email: string; response: AuthenticationResponseJSON }) => input,
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { rpID, origin } = getRpAndOrigin();
    const email = normalizeEmail(data.email);

    // Throttle: reserve an attempt slot.
    const { data: beginData, error: beginErr } = await supabaseAdmin.rpc(
      "begin_auth_attempt",
      { _email: email, _attempt_type: "signin" },
    );
    if (beginErr) throw new Error(beginErr.message);
    const begin = beginData as {
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

      // Confirm this credential belongs to the claimed email
      const { data: emailOwnerId } = await supabaseAdmin
        .rpc("lookup_user_id_by_email", { _email: email })
        .then((r) => ({ data: r.data as string | null }))
        .catch(() => ({ data: null }));
      if (!emailOwnerId || emailOwnerId !== credRow.user_id) {
        throw new Error("Passkey does not belong to this account");
      }

      const publicKeyBytes = pgByteaToBytes(credRow.public_key as unknown as string);

      const verification = await verifyAuthenticationResponse({
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

      // Update counter + last_used
      await supabaseAdmin
        .from("webauthn_credentials")
        .update({
          counter: verification.authenticationInfo.newCounter,
          last_used_at: new Date().toISOString(),
        })
        .eq("id", credRow.id);

      await supabaseAdmin
        .from("webauthn_challenges")
        .delete()
        .eq("id", challengeRow.id);

      // Mint a session via magiclink. Client redeems with verifyOtp.
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
    if (error) throw new Error(error.message);
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
    if (error) throw new Error(error.message);
    return { ok: true };
  });
