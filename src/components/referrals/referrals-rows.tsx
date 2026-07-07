import { useNavigate } from "@tanstack/react-router";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Baby, HelpCircle, Inbox } from "lucide-react";
import { tzTooltip } from "@/lib/format-timestamp";
import {
  ADMISSION_URGENCY_BADGE,
  ADMISSION_URGENCY_LABELS,
} from "@/lib/admission-urgency";
import { ReferralTimer } from "./referral-timer";
import {
  rowBgStyles,
  statusStyles,
  type Referral,
} from "@/lib/referrals-list-utils";
import { computeNews2Tone, news2ToneClasses, ceilingLabel } from "@/lib/referral-clinical";
import { outcomeLabel } from "@/lib/referral-outcome";


const SKELETON_ROWS = 5;

interface Props {
  rows: Referral[];
  loading: boolean;
  timerSort: "none" | "desc" | "asc";
  onToggleTimerSort: () => void;
}

/**
 * The main referrals list surface: a semantic table at ≥md widths and a
 * card list on phones. Rows are keyboard-activatable — Enter or Space
 * navigates to the referral detail, matching mouse click behaviour.
 */
export function ReferralsRows({ rows, loading, timerSort, onToggleTimerSort }: Props) {
  const navigate = useNavigate();

  return (
    <>
      {/* Desktop table */}
      <div className="hidden md:block border rounded-md bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2">Received</th>
                <th className="text-left px-3 py-2">Hosp. no</th>
                <th className="text-left px-3 py-2">Age/Sex</th>
                <th className="text-left px-3 py-2">Location</th>
                <th className="text-left px-3 py-2">Specialty</th>
                <th className="text-left px-3 py-2">Reason</th>
                <th className="text-left px-3 py-2">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 uppercase hover:text-foreground"
                    onClick={onToggleTimerSort}
                    aria-label="Sort by timer"
                  >
                    Timer
                    <span className="text-[10px]" aria-hidden="true">
                      {timerSort === "desc" ? "↓" : timerSort === "asc" ? "↑" : "↕"}
                    </span>
                  </button>
                </th>
                <th className="text-left px-3 py-2">Urgency</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2">Taken by</th>
              </tr>
            </thead>
            <tbody>
              {loading && Array.from({ length: SKELETON_ROWS }).map((_, i) => (
                <tr key={`sk-${i}`} className="border-t">
                  {Array.from({ length: 10 }).map((__, j) => (
                    <td key={j} className="px-3 py-3">
                      <Skeleton className="h-3 w-full max-w-[120px]" />
                    </td>
                  ))}
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-3 py-4">
                    <EmptyState
                      icon={Inbox}
                      title="No referrals match"
                      description="Try clearing filters or adjusting the date range to widen the search."
                      compact
                    />
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={`border-t cursor-pointer transition-colors duration-150 hover:bg-muted/40 ${rowBgStyles[r.status] ?? ""}`}
                  role="link"
                  tabIndex={0}
                  onClick={() => navigate({ to: "/referrals/$id", params: { id: r.id } })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      navigate({ to: "/referrals/$id", params: { id: r.id } });
                    }
                  }}
                >
                  <td className="px-3 py-2 whitespace-nowrap" title={tzTooltip(r.referral_received_at)}>
                    {format(new Date(r.referral_received_at), "dd/MM/yyyy HH:mm")}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span>{r.hospital_number ?? "—"}</span>
                      {(r as any).is_test && (
                        <Badge
                          variant="outline"
                          className="border-warning/50 bg-warning/10 text-warning-text text-[10px] px-1.5 py-0"
                          title="Test/demonstration entry — excluded from analytics"
                        >
                          Test
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      {r.age !== null && r.age <= 16 && (
                        <span title="Pediatric patient (≤16)">
                          <Baby className="w-4 h-4 text-primary" aria-label="Pediatric" />
                        </span>
                      )}
                      {r.age === null && (
                        <span
                          title="Age not recorded — cannot be classified as pediatric"
                          className="inline-flex items-center gap-1 rounded border border-warning/50 bg-warning/10 text-warning-text px-1.5 py-0 text-[10px] font-medium"
                        >
                          <HelpCircle className="w-3 h-3" aria-hidden="true" />
                          Age unknown
                        </span>
                      )}
                      <span>{r.age ?? "?"} / {r.sex ?? "?"}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2">{r.current_ward ?? "—"} {r.current_bed ? `· ${r.current_bed}` : ""}</td>
                  <td className="px-3 py-2">{r.referring_specialty ?? "—"}</td>
                  <td className="px-3 py-2 max-w-xs truncate">{r.reason_for_referral ?? "—"}</td>
                  <td className="px-3 py-2"><ReferralTimer r={r} /></td>
                  <td className="px-3 py-2">
                    {r.admission_urgency ? (
                      <Badge variant="outline" className={`whitespace-nowrap ${ADMISSION_URGENCY_BADGE[r.admission_urgency]}`}>
                        {ADMISSION_URGENCY_LABELS[r.admission_urgency]}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant="outline" className={`capitalize ${statusStyles[r.status]}`}>{r.status}</Badge>
                    {r.status === "admitted" && (r as any).accepting_consultant && (
                      <div className="text-xs text-muted-foreground mt-1 whitespace-nowrap">
                        Accepted by {(r as any).accepting_consultant}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.creator_name
                      ? r.creator_name
                      : <span className="text-xs text-muted-foreground">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden flex flex-col gap-3">
        {loading && Array.from({ length: SKELETON_ROWS }).map((_, i) => (
          <div key={`sk-${i}`} className="border rounded-lg p-4 space-y-2 bg-card">
            <div className="flex items-center justify-between">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-4 w-16" />
            </div>
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
        {!loading && rows.length === 0 && (
          <EmptyState
            icon={Inbox}
            title="No referrals match"
            description="Try clearing filters or adjusting the date range to widen the search."
          />
        )}
        {rows.map((r) => (
          <div
            key={r.id}
            className={`border rounded-lg p-4 cursor-pointer active:scale-[0.99] transition-[transform,colors,background-color] duration-150 hover:bg-muted/30 ${rowBgStyles[r.status] ?? "bg-card"}`}
            role="link"
            tabIndex={0}
            onClick={() => navigate({ to: "/referrals/$id", params: { id: r.id } })}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                navigate({ to: "/referrals/$id", params: { id: r.id } });
              }
            }}
          >
            <div className="flex flex-col gap-2 mb-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground shrink-0" title={tzTooltip(r.referral_received_at)}>
                  {format(new Date(r.referral_received_at), "dd/MM/yyyy HH:mm")}
                </span>
                <div className="flex items-center gap-1.5">
                  {(r as any).is_test && (
                    <Badge
                      variant="outline"
                      className="border-warning/50 bg-warning/10 text-warning-text text-[10px] px-1.5 py-0"
                      title="Test/demonstration entry — excluded from analytics"
                    >
                      Test
                    </Badge>
                  )}
                  <Badge variant="outline" className={`capitalize text-xs shrink-0 ${statusStyles[r.status]}`}>
                    {r.status}
                  </Badge>
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <ReferralTimer r={r} />
                {r.admission_urgency && (
                  <Badge variant="outline" className={`text-xs whitespace-nowrap ${ADMISSION_URGENCY_BADGE[r.admission_urgency]}`}>
                    {ADMISSION_URGENCY_LABELS[r.admission_urgency]}
                  </Badge>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              <div>
                <span className="text-xs text-muted-foreground block">Hospital No</span>
                <span className="font-medium">{r.hospital_number ?? "—"}</span>
              </div>
              <div>
                <span className="text-xs text-muted-foreground block">Age / Sex</span>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {r.age !== null && r.age <= 16 && (
                    <span title="Pediatric patient (≤16)">
                      <Baby className="w-4 h-4 text-primary" aria-label="Pediatric" />
                    </span>
                  )}
                  <span className="font-medium">{r.age ?? "?"} / {r.sex ?? "?"}</span>
                  {r.age === null && (
                    <span
                      title="Age not recorded — cannot be classified as pediatric"
                      className="inline-flex items-center gap-1 rounded border border-warning/50 bg-warning/10 text-warning-text px-1.5 py-0 text-[10px] font-medium"
                    >
                      <HelpCircle className="w-3 h-3" aria-hidden="true" />
                      Age unknown
                    </span>
                  )}
                </div>
              </div>

              <div>
                <span className="text-xs text-muted-foreground block">Location</span>
                <span className="font-medium">{r.current_ward ?? "—"} {r.current_bed ? `· ${r.current_bed}` : ""}</span>
              </div>
              <div>
                <span className="text-xs text-muted-foreground block">Specialty</span>
                <span className="font-medium">{r.referring_specialty ?? "—"}</span>
              </div>
              <div className="col-span-2">
                <span className="text-xs text-muted-foreground block">Reason</span>
                <span className="font-medium line-clamp-2">{r.reason_for_referral ?? "—"}</span>
              </div>
              <div className="col-span-2">
                <span className="text-xs text-muted-foreground block">Taken by</span>
                <span className="font-medium">
                  {r.creator_name
                    ? r.creator_name
                    : "—"}
                </span>
              </div>
              {r.status === "admitted" && (r as any).accepting_consultant && (
                <div className="col-span-2">
                  <span className="text-xs text-muted-foreground block">Accepted by</span>
                  <span className="font-medium">{(r as any).accepting_consultant}</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
