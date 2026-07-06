import { useNavigate } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { format, parseISO } from "date-fns";

interface Props {
  specialty?: string;
  from?: string;
  to?: string;
}

/**
 * Sticky drill-down summary row shown when the user arrives from an analytics
 * chart click. Every badge has its own clear affordance; "Clear all" wipes the
 * URL search params in one go.
 */
export function ReferralsDrilldownBadges({ specialty, from, to }: Props) {
  const navigate = useNavigate();
  if (!specialty && !from && !to) return null;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
      <span className="text-xs uppercase text-muted-foreground">Drill-down</span>
      {specialty && (
        <Badge variant="secondary" className="gap-1">
          Specialty: {specialty}
          <button
            type="button"
            aria-label="Clear specialty filter"
            className="ml-1 opacity-70 hover:opacity-100"
            onClick={() =>
              navigate({
                to: "/",
                search: (p: Record<string, unknown>) => ({ ...p, specialty: undefined }),
              })
            }
          >
            ×
          </button>
        </Badge>
      )}
      {(from || to) && (
        <Badge variant="secondary" className="gap-1">
          Date: {from ? format(parseISO(from), "dd/MM/yyyy") : "…"}
          {to && to !== from ? ` → ${format(parseISO(to), "dd/MM/yyyy")}` : ""}
          <button
            type="button"
            aria-label="Clear date filter"
            className="ml-1 opacity-70 hover:opacity-100"
            onClick={() =>
              navigate({
                to: "/",
                search: (p: Record<string, unknown>) => ({ ...p, from: undefined, to: undefined }),
              })
            }
          >
            ×
          </button>
        </Badge>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto h-7"
        onClick={() => navigate({ to: "/", search: {} })}
      >
        Clear all
      </Button>
    </div>
  );
}
