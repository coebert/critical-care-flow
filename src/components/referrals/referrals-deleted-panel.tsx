import { RotateCcw } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { RESTORE_WINDOW_DAYS } from "@/lib/referrals.functions";
import type { Referral } from "@/lib/referrals-list-utils";

interface Props {
  rows: Referral[];
  loading: boolean;
  restoringId: string | null;
  onRestore: (id: string) => void;
}

/**
 * "Recently deleted" panel — desktop table + mobile card list. Rows are
 * restorable for RESTORE_WINDOW_DAYS after deletion; anything older is
 * hard-purged server-side and won't appear here.
 */
export function ReferralsDeletedPanel({ rows, loading, restoringId, onRestore }: Props) {
  return (
    <div className="border rounded-md bg-card overflow-hidden mb-6">
      <div className="px-3 py-2 border-b bg-muted/40 text-sm flex items-center justify-between">
        <span className="font-medium">Recently deleted</span>
        <span className="text-xs text-muted-foreground">
          Restorable within {RESTORE_WINDOW_DAYS} days of deletion
        </span>
      </div>
      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2">Deleted</th>
              <th className="text-left px-3 py-2">Hosp. no</th>
              <th className="text-left px-3 py-2">Location</th>
              <th className="text-left px-3 py-2">Specialty</th>
              <th className="text-left px-3 py-2">Reason</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">No restorable referrals.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                  {r.deleted_at ? `${formatDistanceToNow(new Date(r.deleted_at))} ago` : "—"}
                </td>
                <td className="px-3 py-2">{r.hospital_number ?? "—"}</td>
                <td className="px-3 py-2">
                  {r.current_ward ?? "—"} {r.current_bed ? `· ${r.current_bed}` : ""}
                </td>
                <td className="px-3 py-2">{r.referring_specialty ?? "—"}</td>
                <td className="px-3 py-2 max-w-xs truncate">{r.reason_for_referral ?? "—"}</td>
                <td className="px-3 py-2 text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={restoringId === r.id}
                    onClick={() => onRestore(r.id)}
                  >
                    <RotateCcw className="w-3.5 h-3.5 mr-1" aria-hidden="true" />
                    {restoringId === r.id ? "Restoring…" : "Restore"}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Mobile cards */}
      <div className="md:hidden flex flex-col gap-2 p-3">
        {loading && (
          <div className="text-center text-muted-foreground py-6">Loading…</div>
        )}
        {!loading && rows.length === 0 && (
          <div className="text-center text-muted-foreground py-6">No restorable referrals.</div>
        )}
        {rows.map((r) => (
          <div key={r.id} className="border rounded-lg bg-background p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                Deleted {r.deleted_at ? `${formatDistanceToNow(new Date(r.deleted_at))} ago` : "—"}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={restoringId === r.id}
                onClick={() => onRestore(r.id)}
              >
                <RotateCcw className="w-3.5 h-3.5 mr-1" aria-hidden="true" />
                {restoringId === r.id ? "Restoring…" : "Restore"}
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
              <div>
                <span className="text-xs text-muted-foreground block">Hosp. no</span>
                <span className="font-medium">{r.hospital_number ?? "—"}</span>
              </div>
              <div>
                <span className="text-xs text-muted-foreground block">Specialty</span>
                <span className="font-medium">{r.referring_specialty ?? "—"}</span>
              </div>
              <div className="col-span-2">
                <span className="text-xs text-muted-foreground block">Location</span>
                <span className="font-medium">
                  {r.current_ward ?? "—"} {r.current_bed ? `· ${r.current_bed}` : ""}
                </span>
              </div>
              <div className="col-span-2">
                <span className="text-xs text-muted-foreground block">Reason</span>
                <span className="font-medium line-clamp-2">{r.reason_for_referral ?? "—"}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
