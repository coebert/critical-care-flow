import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { format, formatDistanceToNow } from "date-fns";
import { ChevronDown } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { tzTooltip } from "@/lib/format-timestamp";
import {
  getReferralHistory,
  type ReferralAuditEntry,
} from "@/lib/referrals.functions";

const HISTORY_PAGE_SIZE = 20;

const FIELD_LABELS: Record<string, string> = {
  age: "Age",
  sex: "Sex",
  hospital_number: "Hospital number",
  current_ward: "Current ward",
  current_bed: "Bed",
  past_medical_history: "Past medical history",
  baseline_function: "Baseline function",
  dnacpr_respect: "DNACPR / ReSPECT",
  consultant_to_consultant_only: "Consultant-to-consultant only",
  referring_specialty: "Referring specialty",
  reason_for_referral: "Reason for referral",
  referral_received_at: "Referral received",
  first_seen_at: "First seen by CC",
  decision_at: "Decision",
  arrived_on_unit_at: "Arrived on unit",
  status: "Status",
  decline_reason: "Reason for declining",
  discussed_with_consultant: "Discussed with consultant",
  admission_urgency: "Admission urgency",
  accepting_consultant: "Accepting consultant",
  is_test: "Test / demonstration entry",
};

const DATE_FIELDS = new Set([
  "referral_received_at",
  "first_seen_at",
  "decision_at",
  "arrived_on_unit_at",
]);

function formatAuditValue(
  field: string,
  value: string | number | boolean | null,
): string {
  if (value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (DATE_FIELDS.has(field) && typeof value === "string") {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return format(d, "dd/MM/yyyy HH:mm");
  }
  return String(value);
}

function AuditEntry({ entry }: { entry: ReferralAuditEntry }) {
  const when = new Date(entry.created_at);
  const actionLabel =
    entry.action === "create"
      ? "Created"
      : entry.action === "delete"
        ? "Deleted"
        : "Updated";
  const actionTone =
    entry.action === "create"
      ? "bg-success/10 text-success-text border-success/40"
      : entry.action === "delete"
        ? "bg-destructive/10 text-destructive border-destructive/40"
        : "bg-muted text-foreground border-border";

  return (
    <div className="border rounded-md p-3 text-sm">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={cn("capitalize", actionTone)}>
            {actionLabel}
          </Badge>
          <span className="font-medium">{entry.user_name}</span>
        </div>
        <span className="text-xs text-muted-foreground" title={tzTooltip(when)}>
          {format(when, "dd/MM/yyyy HH:mm")} ·{" "}
          {formatDistanceToNow(when, { addSuffix: true })}
        </span>
      </div>

      {entry.action === "create" && entry.snapshot && (
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
          {Object.entries(entry.snapshot)
            .filter(([, v]) => v !== null && v !== "")
            .map(([k, v]) => (
              <div key={k} className="flex gap-1">
                <dt className="text-muted-foreground">
                  {FIELD_LABELS[k] ?? k}:
                </dt>
                <dd className="break-words">{formatAuditValue(k, v)}</dd>
              </div>
            ))}
        </dl>
      )}

      {entry.action === "update" && entry.changes.length > 0 && (
        <ul className="space-y-1 text-xs">
          {entry.changes.map((c) => (
            <li key={c.field}>
              <span className="text-muted-foreground">
                {FIELD_LABELS[c.field] ?? c.field}:
              </span>{" "}
              <span className="line-through text-muted-foreground">
                {formatAuditValue(c.field, c.from)}
              </span>
              {" → "}
              <span className="font-medium">
                {formatAuditValue(c.field, c.to)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Self-contained "Audit trail" card for a referral detail page. Owns its own
 * open/loading/paging state and its own IntersectionObserver, so the parent
 * (referral detail page) does not need to thread history state through its
 * already-crowded scope. Extracted from `routes/_authenticated/referrals.$id`
 * as part of the god-component split.
 */
export function ReferralAuditTrail({ referralId }: { referralId: string }) {
  const fetchHistory = useServerFn(getReferralHistory);
  const [history, setHistory] = useState<ReferralAuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const loadMore = async (reset = false) => {
    if (loading) return;
    if (!reset && !hasMore) return;
    setLoading(true);
    try {
      const currentOffset = reset ? 0 : history.length;
      const page = await fetchHistory({
        data: {
          referral_id: referralId,
          offset: currentOffset,
          limit: HISTORY_PAGE_SIZE,
        },
      });
      setHistory((cur) => (reset ? page.entries : [...cur, ...page.entries]));
      setTotal(page.total);
      setHasMore(page.hasMore);
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to load history");
    } finally {
      setLoading(false);
    }
  };

  // Auto-load the next page of audit history when the sentinel scrolls into view.
  useEffect(() => {
    if (!open || !hasMore) return;
    const node = sentinelRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore(false);
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hasMore, history.length]);

  return (
    <Card className="p-5">
      <Collapsible
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (o && history.length === 0 && !loading) loadMore(true);
        }}
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="w-full flex items-center justify-between text-left"
          >
            <div>
              <h2 className="font-semibold">Audit trail</h2>
              <p className="text-xs text-muted-foreground">
                When key fields were created or changed, and by whom.
                {open && total > 0 && (
                  <span>
                    {" "}
                    · Showing {history.length} of {total}
                  </span>
                )}
              </p>
            </div>
            <ChevronDown
              className={cn(
                "w-4 h-4 transition-transform",
                open && "rotate-180",
              )}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-4">
          {history.length === 0 && loading && (
            <p className="text-xs text-muted-foreground">Loading history…</p>
          )}
          {!loading && history.length === 0 && (
            <p className="text-xs text-muted-foreground">No audit entries.</p>
          )}
          <div className="space-y-3">
            {history.map((h) => (
              <AuditEntry key={h.id} entry={h} />
            ))}
          </div>
          {history.length > 0 && hasMore && (
            <div ref={sentinelRef} className="pt-3 flex justify-center">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => loadMore(false)}
                disabled={loading}
              >
                {loading ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
          {history.length > 0 && !hasMore && (
            <p className="pt-3 text-center text-xs text-muted-foreground">
              End of history.
            </p>
          )}
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
