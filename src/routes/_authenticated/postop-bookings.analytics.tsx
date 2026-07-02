import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/postop-bookings/analytics")({
  beforeLoad: () => {
    throw redirect({ to: "/analytics", search: { view: "postop" } as any });
  },
});
