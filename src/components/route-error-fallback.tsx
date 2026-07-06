import { useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

/**
 * Consistent route-level error UI. Uses `router.invalidate()` on retry so
 * the loader actually re-runs (Query's `reset()` alone only clears the
 * boundary state, not the cache entry).
 */
export function RouteErrorFallback({
  error,
  label,
}: {
  error: Error;
  label: string;
}) {
  const router = useRouter();
  return (
    <div
      className="mx-auto max-w-lg p-6 text-center space-y-3"
      role="alert"
    >
      <h2 className="text-lg font-semibold">{label} could not load</h2>
      <p className="text-sm text-destructive break-words">
        {error?.message ?? "Unknown error"}
      </p>
      <Button
        variant="outline"
        size="sm"
        onClick={() => router.invalidate()}
      >
        Try again
      </Button>
    </div>
  );
}
