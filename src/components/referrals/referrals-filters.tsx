import { Baby, MapPin, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

/**
 * All filter surface for the referrals list: two text inputs plus five
 * chip rows. Every value is controlled by the parent so filters can be
 * persisted, reset, or driven from URL search params without state churn.
 */
export function ReferralsFilters({
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
  topWards,
  pediatricFilter,
  onPediatricFilterChange,
}: Props) {
  return (
    <>
      <div className="flex flex-wrap gap-2 mb-4">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            placeholder="Search by hospital number…"
            value={hospSearch}
            onChange={(e) => onHospSearchChange(e.target.value)}
            className="pl-9"
            aria-label="Search by hospital number"
          />
        </div>
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            placeholder="Search ward, bed, specialty, reason…"
            value={q}
            onChange={(e) => onQChange(e.target.value)}
            className="pl-9"
            aria-label="Search ward, bed, specialty, or reason"
          />
        </div>
        {(["all", "pending", "accepted", "admitted", "declined"] as const).map((s) => (
          <Button
            key={s}
            size="sm"
            variant={statusFilter === s ? "default" : "outline"}
            onClick={() => onStatusFilterChange(s)}
            className="capitalize"
          >
            {s}
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 mb-4 items-center">
        <span className="text-xs uppercase text-muted-foreground mr-1">Date</span>
        {([
          { k: "all", label: "All time" },
          { k: "today", label: "Today" },
          { k: "yesterday", label: "Yesterday" },
          { k: "7d", label: "Last 7 days" },
          { k: "30d", label: "Last 30 days" },
        ] as const).map(({ k, label }) => (
          <Button
            key={k}
            size="sm"
            variant={dateFilter === k ? "default" : "outline"}
            onClick={() => onDateFilterChange(k)}
          >
            {label}
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 mb-4 items-center">
        <span className="text-xs uppercase text-muted-foreground mr-1">Urgency</span>
        <Button
          size="sm"
          variant={urgencyFilter === "all" ? "default" : "outline"}
          onClick={() => onUrgencyFilterChange("all")}
        >
          All
        </Button>
        {ADMISSION_URGENCY_OPTIONS.map((o) => (
          <Button
            key={o.value}
            size="sm"
            variant={urgencyFilter === o.value ? "default" : "outline"}
            onClick={() => onUrgencyFilterChange(o.value)}
          >
            {o.label}
          </Button>
        ))}
      </div>

      {topWards.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4 items-center">
          <span className="text-xs uppercase text-muted-foreground mr-1">Location</span>
          <Button
            size="sm"
            variant={locFilter === "all" ? "default" : "outline"}
            onClick={() => onLocFilterChange("all")}
          >
            All
          </Button>
          {topWards.map((ward) => (
            <Button
              key={ward}
              size="sm"
              variant={locFilter === ward ? "default" : "outline"}
              onClick={() => onLocFilterChange(ward)}
            >
              <MapPin className="w-3 h-3 mr-1" aria-hidden="true" />
              {ward}
            </Button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-4 items-center">
        <span className="text-xs uppercase text-muted-foreground mr-1">Age group</span>
        <Button
          size="sm"
          variant={pediatricFilter === "all" ? "default" : "outline"}
          onClick={() => onPediatricFilterChange("all")}
        >
          All ages
        </Button>
        <Button
          size="sm"
          variant={pediatricFilter === "pediatric" ? "default" : "outline"}
          onClick={() => onPediatricFilterChange("pediatric")}
        >
          <Baby className="w-3.5 h-3.5 mr-1" aria-hidden="true" />
          Pediatric (≤16)
        </Button>
      </div>
    </>
  );
}
