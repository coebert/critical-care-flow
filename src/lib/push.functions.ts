import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";
import { sendPushToMany } from "./push.server";

export const sendTestPushNotification = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    const { data: subs, error } = await supabase
      .from("push_subscriptions")
      .select("endpoint, p256dh, auth")
      .eq("user_id", userId);

    if (error) throw safeError("push.test", error, "Failed to look up push subscriptions.");
    if (!subs || subs.length === 0) {
      return { ok: false, sent: 0, error: "No push subscription found. Enable push notifications first." };
    }

    const { goneEndpoints } = await sendPushToMany(
      subs.map((s) => ({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth })),
      {
        title: "Radnor Critical Care — Test",
        body: "Push notifications are working. You'll receive alerts like this while on shift.",
        url: "/",
        tag: "test-push",
      },
    );

    if (goneEndpoints.length) {
      await supabase.from("push_subscriptions").delete().in("endpoint", goneEndpoints);
    }

    return {
      ok: true,
      sent: subs.length - goneEndpoints.length,
      error: null,
    };
  });
