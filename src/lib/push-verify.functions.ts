import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";

export const verifyPushSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { endpoint: string }) => {
    if (!data || typeof data.endpoint !== "string" || !data.endpoint) {
      throw new Error("endpoint is required");
    }
    return { endpoint: data.endpoint };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: row, error } = await supabase
      .from("push_subscriptions")
      .select("endpoint, user_id, user_agent, last_used_at, created_at")
      .eq("endpoint", data.endpoint)
      .maybeSingle();

    if (error) throw safeError("push.verify", error, "Failed to look up push subscription.");

    if (!row) return { found: false as const };
    return {
      found: true as const,
      ownedByCurrentUser: row.user_id === userId,
      userAgent: row.user_agent,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
    };
  });
