// Shared server-only helpers used by *.functions.ts modules.
//
// This module MUST only be imported from within server-function handler
// bodies (never at module scope of a route or component file). The
// `client.server` import it wraps is itself server-only.

export async function getAdmin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}
