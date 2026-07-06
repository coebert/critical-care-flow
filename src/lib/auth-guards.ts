import { safeError } from "./safe-error";

/**
 * Server-side guard: verifies that the caller behind `context` has the
 * `admin` role via the `has_role` security-definer RPC. Callable from any
 * `createServerFn` handler whose middleware chain includes
 * `requireSupabaseAuth` (which puts `supabase` + `userId` on `context`).
 *
 * Throws a `safeError` with a client-safe 403-style message if the caller
 * is not an admin, so surfaces get a consistent "Forbidden" state and the
 * raw provider error is not leaked.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function assertAdmin(context: any): Promise<void> {
  const { data, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  if (error) throw safeError("auth-guards.assertAdmin", error, "Permission check failed.");
  if (!data) {
    throw safeError(
      "auth-guards.assertAdmin",
      new Error("forbidden"),
      "Forbidden: admin role required.",
    );
  }
}
