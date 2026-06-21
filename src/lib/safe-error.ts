/**
 * Wrap a Supabase / Postgres error so the message returned to the client
 * does not leak schema details (table names, constraint names, column
 * descriptions, trigger text, etc.). The full error is logged server-side.
 *
 * Pass a short, user-safe `clientMessage` describing the operation.
 */
export function safeError(scope: string, error: unknown, clientMessage: string): Error {
  // Server-side log retains full detail for diagnostics.
  // eslint-disable-next-line no-console
  console.error(`[${scope}]`, error);

  // A small allow-list of error shapes we surface verbatim because they are
  // user-actionable and do not reveal internal schema.
  const code = (error as any)?.code as string | undefined;
  const message = (error as any)?.message as string | undefined;

  if (code === "PGRST116") return new Error("Record not found.");
  if (code === "23505") return new Error("That record already exists.");
  if (code === "42501" && message && /only the creator|only the author|admin/i.test(message)) {
    // Application-defined authorization message from a trigger — safe to surface.
    return new Error(message);
  }

  return new Error(clientMessage);
}
