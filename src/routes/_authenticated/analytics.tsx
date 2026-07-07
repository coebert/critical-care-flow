import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PostopAnalyticsPanel } from "@/components/postop-analytics-panel";
import { ReferralsAnalyticsPanel } from "@/components/analytics/referrals-panel";
import { NurseCapacityAnalyticsPanel } from "@/components/analytics/nurse-capacity-panel";
import { icnarcTargetsQueryOptions, initialAnalyticsRange } from "@/components/analytics/queries";
import { getReferralsAnalytics, getPostopAnalytics } from "@/lib/analytics.functions";
import { getNurseCapacityAnalytics } from "@/lib/nurse-staffing.functions";
import { AdminOnly } from "@/components/admin-only";
import { RouteErrorFallback } from "@/components/route-error-fallback";

const analyticsSearchSchema = z.object({
  view: z.enum(["referrals", "postop", "nurse-capacity"]).optional(),
});

export const Route = createFileRoute("/_authenticated/analytics")({
  head: () => ({ meta: [{ title: "Analytics — SDH Critical Care" }] }),
  validateSearch: analyticsSearchSchema,
  // Prime caches for the default 30-day window + shared ICNARC targets row.
  // Panel `useQuery`s share these keys, so cold navigation renders without
  // a spinner. Fetches run in parallel; failures don't block the route.
  loader: ({ context }) => {
    const { fromIso, toIso } = initialAnalyticsRange();
    void context.queryClient.prefetchQuery({
      queryKey: ["analytics", "referrals", fromIso, toIso],
      queryFn: () => getReferralsAnalytics({ data: { from: fromIso, to: toIso } }),
    });
    void context.queryClient.prefetchQuery({
      queryKey: ["analytics", "postop", fromIso, toIso],
      queryFn: () => getPostopAnalytics({ data: { from: fromIso, to: toIso } }),
    });
    void context.queryClient.prefetchQuery({
      queryKey: ["analytics", "nurse-capacity", fromIso.slice(0, 10), toIso.slice(0, 10)],
      queryFn: () => getNurseCapacityAnalytics({ data: { from: fromIso.slice(0, 10), to: toIso.slice(0, 10) } }),
    });
    void context.queryClient.prefetchQuery(icnarcTargetsQueryOptions);
  },
  errorComponent: ({ error }) => <RouteErrorFallback error={error} label="Analytics" />,
  component: () => (
    <AdminOnly redirectTo="/postop-bookings">
      <AnalyticsPage />
    </AdminOnly>
  ),
});

function AnalyticsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const tab: "referrals" | "postop" = search.view === "postop" ? "postop" : "referrals";

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
      </div>
      <Tabs
        value={tab}
        onValueChange={(v) =>
          navigate({ search: { view: v === "postop" ? "postop" : undefined }, replace: true })
        }
      >
        <TabsList className="mb-4">
          <TabsTrigger value="referrals">Referrals</TabsTrigger>
          <TabsTrigger value="postop">Post-op bookings</TabsTrigger>
        </TabsList>
        <TabsContent value="referrals">
          <ReferralsAnalyticsPanel />
        </TabsContent>
        <TabsContent value="postop">
          <PostopAnalyticsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
