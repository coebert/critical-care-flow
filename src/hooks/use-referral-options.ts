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

// Sort consultant display names by surname (last whitespace-delimited token),
// then by the remaining given-name tokens, then by the full string as a
// final deterministic tie-breaker. Case- and accent-insensitive.
export function compareConsultantsBySurname(a: string, b: string): number {
  const collator = new Intl.Collator("en", { sensitivity: "base", usage: "sort" });
  const parse = (s: string) => {
    const parts = s.trim().split(/\s+/);
    const surname = parts.length > 1 ? parts[parts.length - 1] : parts[0] ?? "";
    const given = parts.length > 1 ? parts.slice(0, -1).join(" ") : "";
    return { surname, given };
  };
  const pa = parse(a);
  const pb = parse(b);
  return (
    collator.compare(pa.surname, pb.surname) ||
    collator.compare(pa.given, pb.given) ||
    collator.compare(a, b)
  );
}

export function useReferralOptions() {
  const [specialties, setSpecialties] = useState<string[]>([]);
  const [wards, setWards] = useState<string[]>([]);
  const [consultants, setConsultants] = useState<string[]>(() =>
    [...SEED_CONSULTANTS].sort(compareConsultantsBySurname),
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
        // De-duplicate case-insensitively while preserving first-seen casing.
        const seen = new Map<string, string>();
        for (const name of cs) {
          const key = name.toLowerCase();
          if (!seen.has(key)) seen.set(key, name);
        }
        setSpecialties([...sp].sort((a, b) => a.localeCompare(b)));
        setWards([...wd].sort((a, b) => a.localeCompare(b)));
        setConsultants([...seen.values()].sort(compareConsultantsBySurname));
      });
  }, []);

  return { specialties, wards, consultants };
}
