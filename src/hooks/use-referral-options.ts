import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

// Seed list of critical care consultants, alphabetical by surname.
// Merged with names already saved on referrals so the dropdown always
// offers the established consultants even before any referral has been
// recorded against them.
export const SEED_CONSULTANTS: string[] = [
  "C Billingham",
  "R Coe",
  "C Couzens",
  "L Fenner",
  "J Haslam",
  "I Jenkins",
  "S Jukes",
  "C Morden",
  "A Nash",
  "J Walsgrove",
  "J Ward",
];

export function useReferralOptions() {
  const [specialties, setSpecialties] = useState<string[]>([]);
  const [wards, setWards] = useState<string[]>([]);
  const [consultants, setConsultants] = useState<string[]>(() =>
    [...SEED_CONSULTANTS].sort((a, b) => a.localeCompare(b)),
  );

  useEffect(() => {
    supabase
      .from("referrals")
      .select("referring_specialty,current_ward,accepting_consultant,discussed_with_consultant")
      .is("deleted_at", null)
      .then(({ data }) => {
        const sp = new Set<string>();
        const wd = new Set<string>();
        const cs = new Set<string>(SEED_CONSULTANTS);
        (data ?? []).forEach((r: any) => {
          if (r.referring_specialty?.trim()) sp.add(r.referring_specialty.trim());
          if (r.current_ward?.trim()) wd.add(r.current_ward.trim());
          if (r.accepting_consultant?.trim()) cs.add(r.accepting_consultant.trim());
          if (r.discussed_with_consultant?.trim()) cs.add(r.discussed_with_consultant.trim());
        });
        setSpecialties([...sp].sort((a, b) => a.localeCompare(b)));
        setWards([...wd].sort((a, b) => a.localeCompare(b)));
        setConsultants([...cs].sort((a, b) => a.localeCompare(b)));
      });
  }, []);

  return { specialties, wards, consultants };
}
