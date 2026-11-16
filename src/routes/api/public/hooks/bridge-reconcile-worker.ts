import { createFileRoute } from "@tanstack/react-router";
import { isBridgeCallerAuthorized } from "@/lib/bridge-caller-auth.server";
import { retiredBridgeStatus } from "@/lib/bridge-mirror-retired";

/**
 * RETIRED bed reconciliation worker (see src/lib/bridge-mirror-retired.ts).
 *
 * pg_cron still calls this every minute; it now authenticates the caller and
 * returns the retired status. No jobs are claimed, finalised or replayed, no
 * local patient/bed copies are pushed, and queued rows are left untouched.
 * It also re-evaluates shared capacity once per run through the SAME
 * fail-closed, claim-deduplicated alert path used after bed / staffing /
 * acuity saves (same recipients and channels — no new notification scope),
 * so Hub-side occupancy changes are noticed within about a minute.
 */
export const Route = createFileRoute("/api/public/hooks/bridge-reconcile-worker")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isBridgeCallerAuthorized(request))) {
          return new Response("Unauthorized", { status: 401 });
        }
        let capacity_check = "error";
        try {
          const [{ supabaseAdmin }, { checkAndAlertNurseCapacity }] = await Promise.all([
            import("@/integrations/supabase/client.server"),
            import("@/lib/nurse-capacity-alerts.server"),
          ]);
          capacity_check = (await checkAndAlertNurseCapacity(supabaseAdmin)).kind;
        } catch {
          capacity_check = "error";
        }
        return Response.json({ ...retiredBridgeStatus(), capacity_check });
      },
    },
  },
});
