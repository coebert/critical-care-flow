import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export function useReferralOptions() {
  const [specialties, setSpecialties] = useState<string[]>([]);
  const [wards, setWards] = useState<string[]>([]);
  const [consultants, setConsultants] = useState<string[]>([]);

  useEffect(() => {
    supabase
      .from("referrals")
      .select("referring_specialty,current_ward,accepting_consultant")
      .is("deleted_at", null)
      .then(({ data }) => {
        const sp = new Set<string>();
        const wd = new Set<string>();
        const cs = new Set<string>();
        (data ?? []).forEach((r: any) => {
          if (r.referring_specialty?.trim()) sp.add(r.referring_specialty.trim());
          if (r.current_ward?.trim()) wd.add(r.current_ward.trim());
          if (r.accepting_consultant?.trim()) cs.add(r.accepting_consultant.trim());
        });
        setSpecialties([...sp].sort((a, b) => a.localeCompare(b)));
        setWards([...wd].sort((a, b) => a.localeCompare(b)));
        setConsultants([...cs].sort((a, b) => a.localeCompare(b)));
      });
  }, []);

  return { specialties, wards, consultants };
}
