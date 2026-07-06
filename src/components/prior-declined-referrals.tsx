import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { format } from "date-fns";

import { Card } from "@/components/ui/card";
import { findReferralsByHospitalNumber, type DecryptedReferral } from "@/lib/referrals.functions";
import { tzTooltip } from "@/lib/format-timestamp";
import type { Tables } from "@/integrations/supabase/types";

type Referral = Tables<"referrals"> & DecryptedReferral;

/**
 * Extracted from `referrals.$id.tsx`. Renders a warning card listing any
 * previously-declined critical-care referrals for the same patient
 * (matched by hospital number, excluding the current referral). Owns its
 * own fetch so the parent route only decides whether the section should
 * appear at all — hospital number + current id are the only inputs.
 */
export function PriorDeclinedReferrals({
  hospitalNumber,
  excludeId,
}: {
  hospitalNumber: string | null | undefined;
  excludeId: string;
}) {
  const fetchPriors = useServerFn(findReferralsByHospitalNumber);
  const hn = hospitalNumber?.trim() ?? "";
  const enabled = hn.length > 0;

  const { data } = useQuery({
    queryKey: ["referrals", "prior-declined", hn, excludeId] as const,
    queryFn: async () => {
      const rows = (await fetchPriors({
        data: { hospital_number: hn, exclude_id: excludeId },
      })) as unknown as Referral[];
      return (rows ?? []).filter((r) => r.status === "declined");
    },
    enabled,
    staleTime: 30_000,
  });

  const priors = data ?? [];
  if (!enabled || priors.length === 0) return null;

  return (
    <Card className="p-5 space-y-3 border-destructive/40">
      <div className="flex items-center gap-2">
        <AlertCircle className="w-4 h-4 text-destructive" />
        <h2 className="font-semibold text-destructive">
          Previously declined critical care referral{priors.length > 1 ? "s" : ""} for this patient
        </h2>
      </div>
      <p className="text-xs text-muted-foreground">
        Same hospital number ({hn}). Full decline reasons shown below.
      </p>
      <div className="space-y-3">
        {priors.map((p) => {
          const when = p.decision_at ?? p.referral_received_at;
          return (
            <div key={p.id} className="border rounded-md p-3 bg-destructive/5">
              <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                <div className="text-sm font-medium" title={when ? tzTooltip(when) : undefined}>
                  Declined {when ? format(new Date(when), "dd/MM/yyyy HH:mm") : "date unknown"}
                  {p.referring_specialty ? ` · ${p.referring_specialty}` : ""}
                </div>
                <Link
                  to="/referrals/$id"
                  params={{ id: p.id }}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs underline text-muted-foreground hover:text-foreground"
                >
                  Open full referral
                </Link>
              </div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                Reason for declining
              </div>
              {p.decline_reason ? (
                <p className="text-sm whitespace-pre-wrap">{p.decline_reason}</p>
              ) : (
                <p className="text-sm italic text-muted-foreground">No reason recorded.</p>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
