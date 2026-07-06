import { queryOptions } from "@tanstack/react-query";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";

export const KIND_VALUES = ["all", "new", "status", "note", "updated", "warning"] as const;
export const PAGE_SIZE = 25;

export const inboxSearchSchema = z.object({
  tab: fallback(z.enum(["all", "unread"]), "all").default("all"),
  q: fallback(z.string(), "").default(""),
  kind: fallback(z.enum(KIND_VALUES), "all").default("all"),
  from: fallback(z.string(), "").default(""),
  to: fallback(z.string(), "").default(""),
  sort: fallback(z.enum(["newest", "oldest"]), "newest").default("newest"),
  page: fallback(z.number().int().min(1), 1).default(1),
});
export type InboxSearch = z.infer<typeof inboxSearchSchema>;
export const inboxSearchValidator = zodValidator(inboxSearchSchema);

export interface Notification {
  id: string;
  referral_id: string | null;
  kind: string;
  message: string;
  read_at: string | null;
  created_at: string;
}

export const NOTIFICATIONS_QUERY_KEY = ["notifications", "list"] as const;

export const notificationsQueryOptions = queryOptions({
  queryKey: NOTIFICATIONS_QUERY_KEY,
  queryFn: async (): Promise<Notification[]> => {
    const { data, error } = await supabase
      .from("notifications")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    return (data ?? []) as Notification[];
  },
  staleTime: 10_000,
});

export function kindLabel(kind: string): string {
  switch (kind) {
    case "new": return "New referral";
    case "status": return "Status change";
    case "note": return "New note";
    case "updated": return "Referral updated";
    case "warning": return "Warning";
    default: return kind;
  }
}
