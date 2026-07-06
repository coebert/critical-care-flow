import { Link, useNavigate } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { Bell, Check, ChevronLeft, ChevronRight, ExternalLink, Filter, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { kindLabel, PAGE_SIZE, type Notification } from "@/lib/inbox-utils";

interface Props {
  loading: boolean;
  busy: boolean;
  visible: Notification[];
  filteredCount: number;
  page: number;
  totalPages: number;
  pageStart: number;
  hasFilters: boolean;
  tab: "all" | "unread";
  selected: Set<string>;
  visibleIds: string[];
  allVisibleSelected: boolean;
  someVisibleSelected: boolean;
  toggleOne: (id: string, checked: boolean) => void;
  toggleAllVisible: (checked: boolean) => void;
  clearSelection: () => void;
  bulkMark: (asRead: boolean) => void;
  markRead: (id: string) => void;
  markUnread: (id: string) => void;
  setPage: (page: number) => void;
}

export function InboxList(props: Props) {
  const {
    loading, busy, visible, filteredCount, page, totalPages, pageStart, hasFilters, tab,
    selected, visibleIds, allVisibleSelected, someVisibleSelected,
    toggleOne, toggleAllVisible, clearSelection, bulkMark, markRead, markUnread, setPage,
  } = props;
  const navigate = useNavigate();

  return (
    <>
      {visible.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap px-1">
          <Checkbox
            id="select-all-visible"
            checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
            onCheckedChange={(c) => toggleAllVisible(c === true)}
            aria-label="Select all visible notifications"
          />
          <label htmlFor="select-all-visible" className="text-sm text-muted-foreground cursor-pointer">
            {selected.size > 0 ? `${selected.size} selected` : "Select page"}
          </label>
          {selected.size > 0 && (
            <div className="flex items-center gap-2 ml-auto">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => bulkMark(true)}>
                <Check className="w-4 h-4 mr-1" aria-hidden="true" /> Mark read
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => bulkMark(false)}>
                Mark unread
              </Button>
              <Button size="sm" variant="ghost" onClick={clearSelection} aria-label="Clear selection">
                <X className="w-4 h-4" />
              </Button>
            </div>
          )}
        </div>
      )}
      <Card className="divide-y">
        {loading ? (
          <div className="divide-y">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-start gap-3 p-3">
                <Skeleton className="h-4 w-4 mt-1 rounded" />
                <Skeleton className="h-2 w-2 rounded-full mt-2" />
                <div className="flex-1 space-y-2">
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="h-3 w-16" />
                  </div>
                  <Skeleton className="h-3 w-full max-w-md" />
                </div>
              </div>
            ))}
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon={hasFilters ? Filter : Bell}
            title={
              hasFilters
                ? "No notifications match your filters"
                : tab === "unread"
                ? "No unread notifications"
                : "No notifications yet"
            }
            description={
              hasFilters
                ? "Try widening the date range or clearing the type filter."
                : tab === "unread"
                ? "You're all caught up. New alerts will appear here."
                : "You'll see referral updates, notes, and system alerts here as they arrive."
            }
          />
        ) : (
          visible.map((n) => {
            const isChecked = selected.has(n.id);
            const rowClass = `flex items-start gap-3 p-3 transition-colors duration-150 hover:bg-accent ${!n.read_at ? "bg-accent/40" : ""}`;
            return (
              <div key={n.id} className={rowClass}>
                <div className="pt-1" onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={isChecked}
                    onCheckedChange={(c) => toggleOne(n.id, c === true)}
                    aria-label={`Select notification ${n.message}`}
                  />
                </div>
                <Link to="/inbox/$id" params={{ id: n.id }} className="flex items-start gap-3 flex-1 min-w-0">
                  <div className="mt-1">
                    <span
                      className={`inline-block w-2 h-2 rounded-full ${n.read_at ? "bg-muted-foreground/30" : "bg-primary"}`}
                      aria-label={n.read_at ? "Read" : "Unread"}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="secondary" className="text-[10px]">{kindLabel(n.kind)}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
                      </span>
                    </div>
                    <div className="text-sm mt-1 break-words">{n.message}</div>
                    <div className="flex items-center gap-2 mt-2">
                      {n.read_at ? (
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs"
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); markUnread(n.id); }}>
                          Mark unread
                        </Button>
                      ) : (
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs"
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); markRead(n.id); }}>
                          <Check className="w-3 h-3 mr-1" aria-hidden="true" /> Mark read
                        </Button>
                      )}
                    </div>
                  </div>
                </Link>
                {n.referral_id && (
                  <div className="pt-1">
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0"
                      title="Open referral"
                      aria-label="Open referral"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!n.read_at) markRead(n.id);
                        navigate({ to: "/referrals/$id", params: { id: n.referral_id! } });
                      }}>
                      <ExternalLink className="w-4 h-4" aria-hidden="true" />
                    </Button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </Card>
      {filteredCount > 0 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground pt-1">
          <span>
            {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, filteredCount)} of {filteredCount}
          </span>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" disabled={page <= 1}
              onClick={() => setPage(page - 1)}>
              <ChevronLeft className="w-4 h-4" aria-hidden="true" /> Prev
            </Button>
            <span className="px-2">Page {page} / {totalPages}</span>
            <Button variant="outline" size="sm" disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}>
              Next <ChevronRight className="w-4 h-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
