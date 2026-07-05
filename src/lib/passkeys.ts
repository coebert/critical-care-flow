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

export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  if (!isPasskeySupported()) return false;
  try {
    // @ts-expect-error — not in all lib.dom versions
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
  const options = await startPasskeyRegistration();
  const response = await startRegistration({ optionsJSON: options });
  await verifyPasskeyRegistration({
    data: {
      response,
      deviceLabel: (deviceLabel?.trim() || defaultDeviceLabel()).slice(0, 100),
    },
  });
}

/** Sign in with a passkey for the given email. Hydrates the Supabase session. */
export async function signInWithPasskey(email: string): Promise<void> {
  if (!isPasskeySupported()) {
    throw new Error("Passkeys are not supported in this browser");
  }
  const trimmed = email.trim();
  if (!trimmed) throw new Error("Please enter your email address");

  const options = await startPasskeyAuthentication({ data: { email: trimmed } });
  const response = await startAuthentication({ optionsJSON: options });

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

export function passkeyEnrollDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(PASSKEY_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function setPasskeyEnrollDismissed(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(PASSKEY_DISMISS_KEY, "1");
    else window.localStorage.removeItem(PASSKEY_DISMISS_KEY);
  } catch {
    /* storage unavailable */
  }
}
