/**
 * Wrap a Supabase / Postgres error so the message returned to the client
 * does not leak schema details (table names, constraint names, column
 * descriptions, trigger text, etc.). The full error is logged server-side.
 *
 * Pass a short, user-safe `clientMessage` describing the operation.
 */

// Explicit allow-list of trigger-defined authorization messages that are
// safe to surface verbatim. Anything else with SQLSTATE 42501 becomes the
// generic `clientMessage` — the previous free-form regex match was easy to
// bypass by any future trigger that happens to say "admin" in its message.
const SAFE_42501_MESSAGES = new Set<string>([
  "Only the creator or an admin can soft-delete or restore this referral",
  "Only the creator or an admin can soft-delete or restore this booking",
  "Only the author or an admin can delete this note",
  "Only read_at may be modified on a notification",
  "Authentication required",
]);

// SQLSTATE → user-safe message. Keep short — anything nuanced belongs in a
// dedicated code branch.
const SAFE_CODE_MESSAGES: Record<string, string> = {
  PGRST116: "Record not found.",
  "23505": "That record already exists.",
  "23503": "Related record is missing or already removed.",
  "22023": "The request is invalid.",
};

export function safeError(scope: string, error: unknown, clientMessage: string): Error {
  // Server-side log retains full detail for diagnostics.
  // eslint-disable-next-line no-console
  console.error(`[${scope}]`, error);

  const code = (error as { code?: string } | null | undefined)?.code;
  const message = (error as { message?: string } | null | undefined)?.message;

  if (code && SAFE_CODE_MESSAGES[code]) {
    return new Error(SAFE_CODE_MESSAGES[code]);
  }
  if (code === "42501" && message && SAFE_42501_MESSAGES.has(message)) {
    return new Error(message);
  }

  return new Error(clientMessage);
}
