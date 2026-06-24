import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { getShiftStatus } from "@/lib/shift.functions";

export function useShiftStatus() {
  const [atWork, setAtWork] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const fn = useServerFn(getShiftStatus);

  useEffect(() => {
    let cancelled = false;
    fn()
      .then((s) => {
        if (!cancelled) setAtWork(!!s.is_at_work);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fn]);

  return { atWork, loading };
}
