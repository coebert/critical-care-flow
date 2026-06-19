import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  beforeLoad: () => {
    // Redirect to authenticated home; guard there sends to /auth if not signed in.
    throw redirect({ to: "/" as any, replace: true });
  },
  component: () => null,
});
