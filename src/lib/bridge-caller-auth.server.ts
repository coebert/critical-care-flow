import { timingSafeEqual } from "node:crypto";

/**
 * Authenticates internal callers of the /api/public/bridge/* and
 * /api/public/hooks/bridge-reconcile-worker routes.
 *
 * Accepts EITHER:
 *   - `x-cron-secret` header matching the private secret stored in Supabase
 *     Vault under `bridge_cron_secret` (used by pg_cron jobs and the
 *     reconcile-job INSERT trigger), OR
 *   - `apikey` header matching `SUPABASE_SERVICE_ROLE_KEY` (used for
 *     trusted internal server-to-server calls).
 *
 * The public Supabase publishable/anon key is NOT accepted — it ships in
 * the client bundle and is not a secret.
 */

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

export async function isBridgeCallerAuthorized(
  request: Request,
): Promise<boolean> {
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = request.headers.get("apikey") ?? "";
  if (serviceRole && apiKey && safeEq(apiKey, serviceRole)) return true;

  const cronHeader = request.headers.get("x-cron-secret") ?? "";
  if (!cronHeader) return false;

  try {
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    const { data, error } = await (supabaseAdmin as any).rpc(
      "get_bridge_cron_secret",
    );
    if (error) return false;
    const expected = typeof data === "string" ? data : "";
    if (!expected) return false;
    return safeEq(cronHeader, expected);
  } catch {
    return false;
  }
}
