import { Filter, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { ReferralsFilters } from "@/components/referrals/referrals-filters";
import { SavedViewsMenu } from "@/components/referrals/saved-views-menu";
import type { SavedViewParams } from "@/lib/referral-saved-views.functions";
import { ADMISSION_URGENCY_OPTIONS, type AdmissionUrgency } from "@/lib/admission-urgency";
import type { DateKey, PediatricKey, StatusKey } from "@/lib/referrals-list-utils";

interface Props {
  hospSearch: string;
  onHospSearchChange: (v: string) => void;
  q: string;
  onQChange: (v: string) => void;
  statusFilter: StatusKey;
  onStatusFilterChange: (v: StatusKey) => void;
  dateFilter: DateKey;
  onDateFilterChange: (v: DateKey) => void;
  urgencyFilter: "all" | AdmissionUrgency;
  onUrgencyFilterChange: (v: "all" | AdmissionUrgency) => void;
  locFilter: string;
  onLocFilterChange: (v: string) => void;
  topWards: string[];
  pediatricFilter: PediatricKey;
  onPediatricFilterChange: (v: PediatricKey) => void;
}

const DATE_LABEL: Record<DateKey, string> = {
  all: "All time",
  today: "Today",
  yesterday: "Yesterday",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

/**
 * Slim search-and-filter toolbar. Two persistent search inputs sit inline;
 * everything else lives behind a "Filters (n)" sheet. Active non-default
 * filters render as removable pills so users can see and clear state without
 * reopening the sheet. Preserves the same controlled props as the old
 * always-expanded filter surface.
 */
export function ReferralsFilterToolbar(props: Props) {
  const {
    hospSearch,
    onHospSearchChange,
    q,
    onQChange,
    statusFilter,
    onStatusFilterChange,
    dateFilter,
    onDateFilterChange,
    urgencyFilter,
    onUrgencyFilterChange,
    locFilter,
    onLocFilterChange,
    pediatricFilter,
    onPediatricFilterChange,
  } = props;

  const activeCount =
    (statusFilter !== "all" ? 1 : 0) +
    (dateFilter !== "all" ? 1 : 0) +
    (urgencyFilter !== "all" ? 1 : 0) +
    (locFilter !== "all" ? 1 : 0) +
    (pediatricFilter !== "all" ? 1 : 0);

  const urgencyLabel =
    urgencyFilter === "all"
      ? null
      : ADMISSION_URGENCY_OPTIONS.find((o) => o.value === urgencyFilter)?.label ?? urgencyFilter;

  const clearAll = () => {
    onStatusFilterChange("all");
    onDateFilterChange("all");
    onUrgencyFilterChange("all");
    onLocFilterChange("all");
    onPediatricFilterChange("all");
  };

  return (
    <div className="mb-3 space-y-2">
      <div className="flex flex-wrap gap-2 items-stretch">
        <div className="relative flex-1 min-w-[180px]">
          <Search
            className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            placeholder="Hospital number…"
            value={hospSearch}
            onChange={(e) => onHospSearchChange(e.target.value)}
            className="pl-9"
            aria-label="Search by hospital number"
          />
        </div>
        <div className="relative flex-1 min-w-[180px]">
          <Search
            className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            placeholder="Ward, bed, specialty, reason…"
            value={q}
            onChange={(e) => onQChange(e.target.value)}
            className="pl-9"
            aria-label="Search ward, bed, specialty, or reason"
          />
        </div>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" className="gap-1.5 shrink-0" aria-label="Open filters">
              <Filter className="w-4 h-4" aria-hidden="true" />
              <span>Filters</span>
              {activeCount > 0 && (
                <Badge variant="secondary" className="ml-1 h-5 px-1.5 tabular-nums">
                  {activeCount}
                </Badge>
              )}
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
            <SheetHeader>
              <SheetTitle>Filter referrals</SheetTitle>
            </SheetHeader>
            <div className="mt-4">
              <ReferralsFilters {...props} hideSearchInputs />
            </div>
            {activeCount > 0 && (
              <div className="mt-4">
                <Button variant="ghost" size="sm" onClick={clearAll}>
                  Clear all filters
                </Button>
              </div>
            )}
          </SheetContent>
        </Sheet>
      </div>

      {activeCount > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Active
          </span>
          {statusFilter !== "all" && (
            <FilterPill
              label={`Status: ${statusFilter}`}
              onClear={() => onStatusFilterChange("all")}
            />
          )}
          {dateFilter !== "all" && (
            <FilterPill
              label={`Date: ${DATE_LABEL[dateFilter]}`}
              onClear={() => onDateFilterChange("all")}
            />
          )}
          {urgencyFilter !== "all" && (
            <FilterPill
              label={`Urgency: ${urgencyLabel}`}
              onClear={() => onUrgencyFilterChange("all")}
            />
          )}
          {locFilter !== "all" && (
            <FilterPill
              label={`Location: ${locFilter}`}
              onClear={() => onLocFilterChange("all")}
            />
          )}
          {pediatricFilter !== "all" && (
            <FilterPill
              label="Pediatric (≤16)"
              onClear={() => onPediatricFilterChange("all")}
            />
          )}
          <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={clearAll}>
            Clear all
          </Button>
        </div>
      )}
    </div>
  );
}

function FilterPill({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border bg-muted/50 pl-2 pr-1 py-0.5 text-xs capitalize">
      {label}
      <button
        type="button"
        onClick={onClear}
        aria-label={`Remove filter ${label}`}
        className="inline-flex items-center justify-center h-5 w-5 rounded-full hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="w-3 h-3" aria-hidden="true" />
      </button>
    </span>
  );
}
