import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

export type DirectoryEntry = { user_id: string; full_name: string; public_key: string | null };

interface UseRecipientDirectoryOptions {
  currentUserId: string | undefined;
  isUnlocked: boolean;
  fetchKeyDir: () => Promise<unknown>;
}

/**
 * Owns the recipient directory: fetch on mount / on unlock, realtime updates
 * from `user_public_keys`, focus/visibility/online refresh, and the transient
 * "just enabled encryption" highlight that fades after 45s.
 *
 * Returns `reload` so callers can force a re-fetch (e.g. before posting a
 * note, when catching a "recipient coverage changed" server error).
 */
export function useRecipientDirectory({
  currentUserId,
  isUnlocked,
  fetchKeyDir,
}: UseRecipientDirectoryOptions) {
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const [newlyEligibleIds, setNewlyEligibleIds] = useState<Set<string>>(new Set());

  // Latest reference so realtime/focus callbacks don't need to be recreated
  // when the caller's `fetchKeyDir` identity changes tick-to-tick.
  const fetchRef = useRef(fetchKeyDir);
  useEffect(() => { fetchRef.current = fetchKeyDir; }, [fetchKeyDir]);

  const reload = useCallback(async (): Promise<DirectoryEntry[] | null> => {
    try {
      const d = (await fetchRef.current()) as any[];
      const list = (d ?? []) as DirectoryEntry[];
      setDirectory((prev) => {
        const wasMissing = new Map(prev.map((r) => [r.user_id, !r.public_key] as const));
        const newlyEnrolled = list.filter(
          (r) => r.public_key && wasMissing.get(r.user_id) === true && r.user_id !== currentUserId,
        );
        if (newlyEnrolled.length > 0 && prev.length > 0) {
          const names = newlyEnrolled.map((r) => r.full_name).slice(0, 3).join(", ");
          const extra = newlyEnrolled.length > 3 ? ` and ${newlyEnrolled.length - 3} more` : "";
          toast.success(`${names}${extra} enabled encryption — recipients updated.`);
          const freshIds = newlyEnrolled.map((r) => r.user_id);
          setNewlyEligibleIds((cur) => {
            const next = new Set(cur);
            freshIds.forEach((uid) => next.add(uid));
            return next;
          });
          window.setTimeout(() => {
            setNewlyEligibleIds((cur) => {
              const next = new Set(cur);
              freshIds.forEach((uid) => next.delete(uid));
              return next;
            });
          }, 45_000);
        }
        return list;
      });
      return list;
    } catch {
      return null;
    }
  }, [currentUserId]);

  // Initial load + reload whenever unlock flips (may reveal new eligibility).
  useEffect(() => {
    if (!currentUserId) return;
    reload();
  }, [currentUserId, isUnlocked, reload]);

  // Realtime + tab-activity refresh — a single subscription per mount.
  useEffect(() => {
    const ch = supabase
      .channel("user-public-keys-directory")
      .on("postgres_changes", { event: "*", schema: "public", table: "user_public_keys" },
        () => { reload(); })
      .subscribe();

    const refresh = () => { reload(); };
    const onVis = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", onVis);

    return () => {
      supabase.removeChannel(ch);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [reload]);

  return { directory, newlyEligibleIds, reload };
}
