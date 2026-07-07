import { Button } from "@/components/ui/button";
import { QUICK_FILTER_LABEL, type QuickFilterKey } from "@/lib/quick-filters";

const KEYS: QuickFilterKey[] = [
  "all",
  "awaiting_review",
  "awaiting_bed",
  "accepted_not_arrived",
  "discussed_pending",
];

export function QuickFilterChips({
  value,
  onChange,
  counts,
}: {
  value: QuickFilterKey;
  onChange: (k: QuickFilterKey) => void;
  counts: Record<QuickFilterKey, number>;
}) {
  return (
    <div className="flex flex-wrap gap-2 mb-3" role="tablist" aria-label="Quick filters">
      {KEYS.map((k) => {
        const active = value === k;
        return (
          <Button
            key={k}
            role="tab"
            aria-selected={active}
            size="sm"
            variant={active ? "default" : "outline"}
            onClick={() => onChange(k)}
            className="h-8"
          >
            {QUICK_FILTER_LABEL[k]}
            <span className={`ml-2 text-[10px] rounded px-1 ${active ? "bg-primary-foreground/20" : "bg-muted"}`}>
              {counts[k]}
            </span>
          </Button>
        );
      })}
    </div>
  );
}
