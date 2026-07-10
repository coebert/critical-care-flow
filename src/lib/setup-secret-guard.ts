/**
 * Pure guard for the `/setup` first-admin bootstrap flow.
 *
 * The `bootstrapFirstAdmin` server function runs this BEFORE it dynamically
 * imports `supabaseAdmin` or touches the database in any way. Anything that
 * causes this function to throw guarantees no auth or DB writes occur — the
 * takeover race is closed at the top of the handler.
 *
 * Kept in its own module (rather than inline in `src/routes/setup.tsx`) so
 * it can be unit-tested without dragging in the TanStack Start server-fn
 * runtime or the Supabase admin client.
 */

/** Timing-safe string compare — constant-time relative to length. */
export function safeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const SETUP_DISABLED_MESSAGE =
  "Setup is disabled. Contact your administrator.";
export const SETUP_INVALID_SECRET_MESSAGE = "Invalid setup secret.";

/**
 * Throws if the provided secret is missing, if the server has no
 * SETUP_SECRET configured, if the configured secret is too short, or if
 * the two don't match. Returns silently only when the caller supplied the
 * exact configured secret.
 *
 * `expected` is passed in (not read from `process.env`) so tests can
 * exercise every branch deterministically.
 */
export function assertSetupSecret(
  provided: string | undefined | null,
  expected: string | undefined | null,
): void {
  if (!expected || expected.length < 16) {
    throw new Error(SETUP_DISABLED_MESSAGE);
  }
  if (typeof provided !== "string" || provided.length === 0) {
    throw new Error(SETUP_INVALID_SECRET_MESSAGE);
  }
  if (!safeEqualStr(provided, expected)) {
    throw new Error(SETUP_INVALID_SECRET_MESSAGE);
  }
}
