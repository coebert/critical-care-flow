/**
 * Central mapper for end-to-end encryption failures.
 *
 * Every user-facing E2E surface — unlock modal, note posting, note editing,
 * background auto-bootstrap — should route its errors through here so the
 * user always gets:
 *   1. A specific reason (not "Something went wrong").
 *   2. A concrete next step ("open Profile > Re-issue keypair", "check your
 *      connection", "unlock encryption from your profile", etc).
 *
 * The mapper is intentionally string-matching: our crypto/publish helpers
 * already throw well-known messages, and we don't want to depend on error
 * classes that would tie this module to the crypto layer.
 */

export type E2EErrorContext =
  /** Bootstrapping (enabling) encryption for the first time. */
  | "bootstrap"
  /** Unwrapping an existing keypair with the user's password. */
  | "unlock"
  /** Auto-issue / auto-unlock after sign-in (runs silently in the background). */
  | "auto-bootstrap"
  /** Encrypting and posting an outgoing note. */
  | "post-note"
  /** Editing an existing encrypted note. */
  | "edit-note"
  /** Decrypting a note we received. */
  | "decrypt-note";

export interface FriendlyE2EError {
  /** One-line headline suitable for a toast title or alert title. */
  title: string;
  /** One or two sentences: the reason + the next step. */
  description: string;
  /**
   * Stable machine key describing the category. Useful for tests and for
   * callers that want to branch UI (e.g. show a "Re-issue key" button when
   * `reason === "wrong_password"` on the unlock flow).
   */
  reason:
    | "wrong_password"
    | "no_material"
    | "network"
    | "publish_failed"
    | "no_recipients"
    | "recipient_coverage_changed"
    | "recipient_missing_public_key"
    | "note_not_found"
    | "corrupt_material"
    | "session_expired"
    | "rate_limited"
    | "unknown";
}

const NETWORK_HINTS = [
  "networkerror",
  "failed to fetch",
  "load failed",
  "network request failed",
  "fetch failed",
  "err_network",
  "timeout",
  "timed out",
];

const AUTH_HINTS = [
  "unauthorized",
  "not authenticated",
  "jwt expired",
  "invalid jwt",
  "401",
];

function lower(err: unknown): string {
  return (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
}

export function friendlyE2EError(err: unknown, context: E2EErrorContext): FriendlyE2EError {
  const msg = lower(err);

  // ---- Session / auth ----------------------------------------------------
  if (AUTH_HINTS.some((h) => msg.includes(h))) {
    return {
      reason: "session_expired",
      title: "Your sign-in has expired",
      description: "Please sign in again to continue using encrypted notes.",
    };
  }

  // ---- Rate limiting -----------------------------------------------------
  if (msg.includes("too many") || msg.includes("rate limit") || msg.includes("429")) {
    return {
      reason: "rate_limited",
      title: "Too many attempts",
      description:
        "You've made too many requests in a short time. Please wait a minute and try again.",
    };
  }

  // ---- Network -----------------------------------------------------------
  if (NETWORK_HINTS.some((h) => msg.includes(h))) {
    return {
      reason: "network",
      title: "Couldn't reach the server",
      description:
        "Check your internet connection and try again. Your notes and password stayed on this device.",
    };
  }

  // ---- Wrong password (unwrap / password confirmation) ------------------
  if (
    msg.includes("incorrect password") ||
    msg.includes("wrong secret key") ||
    msg.includes("crypto_secretbox") ||
    msg.includes("password confirmation failed")
  ) {
    return {
      reason: "wrong_password",
      title: context === "bootstrap" ? "Couldn't enable encryption" : "Incorrect password",
      description:
        "This is the password for your account — the same one you used to sign in. It never leaves this browser. Try again, and if you've forgotten it use \"Forgot your password?\" on the sign-in page.",
    };
  }

  // ---- No material at all (unlock without a stored key) -----------------
  if (msg.includes("no encrypted key")) {
    return {
      reason: "no_material",
      title: "No encryption key found",
      description:
        "We couldn't find an encryption key for your account in this browser. Refresh the page — if this keeps happening, open Profile and choose \"Enable encryption\".",
    };
  }

  // ---- Publish failed during bootstrap/re-issue -------------------------
  if (msg.includes("publish") || (context === "bootstrap" && msg.includes("save"))) {
    return {
      reason: "publish_failed",
      title: "Couldn't save your new encryption key",
      description:
        "Your key was generated in this browser but we couldn't save the public copy to the server. Please try again in a moment.",
    };
  }

  // ---- No recipients enrolled -------------------------------------------
  if (msg.includes("no teammates") && msg.includes("end-to-end")) {
    return {
      reason: "no_recipients",
      title: "No teammates have enabled encryption yet",
      description:
        "Encrypted notes need at least one recipient with a published key. Ask a teammate to sign in — a key is issued automatically for them.",
    };
  }

  if (msg.includes("pick at least one enrolled recipient") || msg.includes("pick at least one recipient")) {
    return {
      reason: "recipient_missing_public_key",
      title: "Pick a recipient with encryption enabled",
      description:
        "Select at least one teammate who has published a public encryption key, then try again.",
    };
  }

  // ---- Server-side coverage change --------------------------------------
  if (msg.includes("recipient_coverage_changed") || msg.includes("recipient list changed")) {
    return {
      reason: "recipient_coverage_changed",
      title: "Recipient list changed",
      description:
        "One or more recipients' keys changed since you started composing. Re-open the recipient picker to review who will receive this note, then post again.",
    };
  }

  // ---- Missing note ------------------------------------------------------
  if (msg.includes("note not found")) {
    return {
      reason: "note_not_found",
      title: "Note not found",
      description:
        "The note you tried to update was moved or deleted. Refresh the page to see the latest notes.",
    };
  }

  // ---- Corrupt / undecodable material -----------------------------------
  if (
    msg.includes("invalid base64") ||
    msg.includes("bad base64") ||
    msg.includes("decode") ||
    msg.includes("length cannot be null") ||
    msg.includes("crypto_pwhash")
  ) {
    return {
      reason: "corrupt_material",
      title: "Encryption data looks corrupted",
      description:
        "The encryption key stored for your account couldn't be read. Open Profile > \"Re-issue my keypair\" to generate a fresh one (note: previously received encrypted notes will become unreadable).",
    };
  }

  // ---- Fallback: use the raw message if it looks safe, else a generic ----
  const raw = err instanceof Error ? err.message : "";
  const contextLabels: Record<E2EErrorContext, string> = {
    bootstrap: "Couldn't enable encryption",
    unlock: "Couldn't unlock notes",
    "auto-bootstrap": "Encryption setup didn't finish",
    "post-note": "Couldn't post encrypted note",
    "edit-note": "Couldn't update encrypted note",
    "decrypt-note": "Couldn't read encrypted note",
  };
  return {
    reason: "unknown",
    title: contextLabels[context],
    description:
      raw && raw.length < 240
        ? `${raw} — please try again, or refresh the page if it keeps happening.`
        : "Something unexpected happened. Please try again, and if it keeps happening refresh the page.",
  };
}
