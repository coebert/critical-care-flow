import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
} from "@simplewebauthn/browser";
import { supabase } from "@/integrations/supabase/client";
import {
  startPasskeyRegistration,
  verifyPasskeyRegistration,
  startPasskeyAuthentication,
  verifyPasskeyAuthentication,
} from "@/lib/webauthn.functions";

export function isPasskeySupported(): boolean {
  return typeof window !== "undefined" && browserSupportsWebAuthn();
}

/**
 * WebAuthn is gated by the `publickey-credentials-create` / `-get`
 * Permissions Policy. In a cross-origin iframe (e.g. the Lovable preview
 * frame) the parent must delegate that policy or the browser rejects
 * navigator.credentials.create() immediately with NotAllowedError — with
 * no user prompt shown. Detect that up-front so we can surface a useful
 * message instead of "setup cancelled".
 */
export function isInCrossOriginIframe(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export function passkeyCreateAllowed(): boolean {
  if (typeof document === "undefined") return true;
  const doc = document as unknown as {
    featurePolicy?: { allowsFeature: (name: string) => boolean };
    permissionsPolicy?: { allowsFeature: (name: string) => boolean };
  };
  const fp = doc.featurePolicy ?? doc.permissionsPolicy;
  if (fp && typeof fp.allowsFeature === "function") {
    try {
      return fp.allowsFeature("publickey-credentials-create");
    } catch {
      /* fall through */
    }
  }
  return !isInCrossOriginIframe();
}

export const PASSKEY_BLOCKED_BY_FRAME = "PASSKEY_BLOCKED_BY_FRAME";

export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  if (!isPasskeySupported()) return false;
  try {
    if (!window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable) {
      return false;
    }
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

function defaultDeviceLabel(): string {
  if (typeof navigator === "undefined") return "This device";
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return "iPhone / iPad";
  if (/Android/i.test(ua)) return "Android device";
  if (/Macintosh/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows device";
  if (/Linux/i.test(ua)) return "Linux device";
  return "This device";
}

/** Register a passkey for the currently signed-in user. */
export async function registerPasskey(deviceLabel?: string): Promise<void> {
  if (!isPasskeySupported()) {
    throw new Error("Passkeys are not supported in this browser");
  }
  if (!passkeyCreateAllowed()) {
    const err = new Error(
      "Your browser is blocking passkey setup inside this preview window. Open the app in its own tab to continue.",
    ) as Error & { code?: string };
    err.code = PASSKEY_BLOCKED_BY_FRAME;
    throw err;
  }
  const options = await startPasskeyRegistration();
  const startedAt = Date.now();
  let response;
  try {
    response = await startRegistration({ optionsJSON: options });
  } catch (err) {
    // Chrome/Safari throw NotAllowedError both for "user cancelled the
    // prompt" and for "Permissions Policy blocked this call". A real
    // cancellation takes at least the time to render the OS prompt
    // (~hundreds of ms). If we get NotAllowedError back in <150 ms, no
    // prompt was ever shown — treat it as a permissions-policy block.
    if (
      err instanceof Error &&
      err.name === "NotAllowedError" &&
      Date.now() - startedAt < 150
    ) {
      const wrapped = new Error(
        "Your browser blocked the passkey prompt. This usually means the app is running inside a preview frame that doesn't allow WebAuthn. Open the app in its own tab and try again.",
      ) as Error & { code?: string };
      wrapped.code = PASSKEY_BLOCKED_BY_FRAME;
      throw wrapped;
    }
    throw err;
  }
  await verifyPasskeyRegistration({
    data: {
      response,
      deviceLabel: (deviceLabel?.trim() || defaultDeviceLabel()).slice(0, 100),
    },
  });
}


export const NO_PASSKEY_REGISTERED = "NO_PASSKEY_REGISTERED";

/** Sign in with a passkey for the given email. Hydrates the Supabase session. */
export async function signInWithPasskey(email: string): Promise<void> {
  if (!isPasskeySupported()) {
    throw new Error("Passkeys are not supported in this browser");
  }
  const trimmed = email.trim();
  if (!trimmed) throw new Error("Please enter your email address");

  const result = await startPasskeyAuthentication({ data: { email: trimmed } });
  // Server returns a discriminated result so we don't have to sniff the
  // options shape to detect "no passkey registered for this account".
  if (result.status === "no_credentials") {
    const err = new Error(
      "No passkey is registered for this email yet. Sign in with your password to set one up.",
    ) as Error & { code?: string };
    err.name = "NoPasskeyRegisteredError";
    err.code = NO_PASSKEY_REGISTERED;
    throw err;
  }
  const response = await startAuthentication({ optionsJSON: result.options });

  const { email: verifiedEmail, token_hash } = await verifyPasskeyAuthentication({
    data: { email: trimmed, response },
  });

  const { error } = await supabase.auth.verifyOtp({
    type: "magiclink",
    token_hash,
    email: verifiedEmail,
  } as Parameters<typeof supabase.auth.verifyOtp>[0]);
  if (error) throw error;
}

export const PASSKEY_DISMISS_KEY = "passkey:enroll-dismissed";

// How long each dismissal suppresses the prompt. After the window elapses,
// a capable device without any enrolled passkeys will be re-prompted on the
// next successful password sign-in.
const SNOOZE_MS: Record<"later" | "never", number> = {
  later: 7 * 24 * 60 * 60 * 1000, // "Not now" — one week
  never: 60 * 24 * 60 * 60 * 1000, // "Don't ask again" — two months
};

type DismissRecord = { mode: "later" | "never"; at: number };

function readDismissRecord(): DismissRecord | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PASSKEY_DISMISS_KEY);
    if (!raw) return null;
    // Back-compat: older builds stored "1" for "don't ask again" with no timestamp.
    if (raw === "1") return { mode: "never", at: Date.now() };
    const parsed = JSON.parse(raw) as Partial<DismissRecord>;
    if (
      (parsed.mode === "later" || parsed.mode === "never") &&
      typeof parsed.at === "number"
    ) {
      return { mode: parsed.mode, at: parsed.at };
    }
    return null;
  } catch {
    return null;
  }
}

export function passkeyEnrollDismissed(): boolean {
  const rec = readDismissRecord();
  if (!rec) return false;
  return Date.now() - rec.at < SNOOZE_MS[rec.mode];
}

function writeDismiss(mode: "later" | "never"): void {
  if (typeof window === "undefined") return;
  try {
    const rec: DismissRecord = { mode, at: Date.now() };
    window.localStorage.setItem(PASSKEY_DISMISS_KEY, JSON.stringify(rec));
  } catch {
    /* storage unavailable */
  }
}

/** "Not now" — short snooze; we'll offer again after a week. */
export function snoozePasskeyEnroll(): void {
  writeDismiss("later");
}

/** "Don't ask again" — long snooze; we'll offer again after ~two months. */
export function setPasskeyEnrollDismissed(value: boolean): void {
  if (typeof window === "undefined") return;
  if (value) {
    writeDismiss("never");
    return;
  }
  try {
    window.localStorage.removeItem(PASSKEY_DISMISS_KEY);
  } catch {
    /* storage unavailable */
  }
}
