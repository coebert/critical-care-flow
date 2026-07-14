import { Card } from "@/components/ui/card";

/**
 * Loading placeholder that mirrors the bed-board grid shape so the layout
 * doesn't jump when data arrives. Respects `prefers-reduced-motion` — the
 * shimmer only runs when motion is allowed.
 */
export function BedGridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <section aria-busy="true" aria-label="Loading bed board">
      <div className="h-4 w-40 mb-2 rounded bg-muted motion-safe:animate-pulse" />
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
        {Array.from({ length: count }).map((_, i) => (
          <Card key={i} className="p-3 min-h-28 space-y-2">
            <div className="flex items-center justify-between">
              <div className="h-4 w-16 rounded bg-muted motion-safe:animate-pulse" />
              <div className="h-4 w-8 rounded bg-muted motion-safe:animate-pulse" />
            </div>
            <div className="h-4 w-3/4 rounded bg-muted motion-safe:animate-pulse" />
            <div className="h-3 w-1/2 rounded bg-muted motion-safe:animate-pulse" />
            <div className="flex gap-1 pt-2">
              <div className="h-4 w-10 rounded bg-muted motion-safe:animate-pulse" />
              <div className="h-4 w-10 rounded bg-muted motion-safe:animate-pulse" />
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}
