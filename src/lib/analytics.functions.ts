import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";
import type { Tables } from "@/integrations/supabase/types";


/**
 * Exported for unit tests. In production `context` is provided by the
 * `requireSupabaseAuth` middleware and always carries `supabase` (RLS-
 * scoped as the caller) plus `userId`. The RPC `has_role` is a security-
 * definer function, so RLS on `user_roles` cannot mask the caller's role.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function assertAdmin(context: any) {
  const { data, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  if (error) throw safeError("analytics.assertAdmin", error, "Permission check failed.");
  if (!data) {
    // Surfaced to the client as a 403-style "Forbidden" state.
    throw safeError(
      "analytics.assertAdmin",
      new Error("forbidden"),
      "Forbidden: analytics are restricted to administrators.",
    );
  }
}

/**
 * Runtime guard: verifies that every row returned by an analytics query has
 * `is_test === false`. If any row slips through with `is_test !== false`
 * (a query that forgot the filter, a nullable column, or a schema drift),
 * the offending rows are logged, dropped from the result, and — in
 * development — the request fails loudly so the regression is caught
 * before it reaches a dashboard.
 */
function assertExcludesTestRows<T extends { is_test?: unknown }>(
  label: string,
  rows: T[],
): T[] {
  const leaked = rows.filter((r) => r.is_test !== false);
  if (leaked.length > 0) {
    console.error(
      `[analytics] ${label}: query returned ${leaked.length} row(s) with is_test !== false — filter missing or broken`,
      { sampleIds: leaked.slice(0, 5).map((r: any) => r?.id ?? null) },
    );
    if (process.env.NODE_ENV !== "production") {
      throw new Error(
        `analytics.${label}: ${leaked.length} row(s) leaked past the is_test=false filter`,
      );
    }
    return rows.filter((r) => r.is_test === false);
  }
  return rows;
}

const rangeSchema = z
  .object({
    from: z.string().datetime(),
    to: z.string().datetime(),
  })
  .refine((r) => new Date(r.from) <= new Date(r.to), {
    message: "from must be <= to",
  });

// Analytics only needs non-PHI columns. Explicitly project them so we never
// pull ciphertext (`*_enc`) or the hospital-number hash into an analytics
// payload — cheaper on the wire and impossible to leak downstream.
const REFERRAL_ANALYTICS_COLUMNS =
  "id,age,sex,current_ward,dnacpr_respect,referring_specialty," +
  "referral_received_at,first_seen_at,decision_at,arrived_on_unit_at," +
  "status,decline_reason,admission_urgency,consultant_to_consultant_only," +
  "accepting_consultant,discussed_with_consultant,is_test," +
  "deleted_at,deleted_by,created_at,created_by,updated_at";

// Server returns the same row shape the analytics UI already consumes
// (`Tables<"referrals">`), but only the safe columns are populated —
// encrypted fields and the hospital-number hash are never selected.
export type ReferralAnalyticsRow = Tables<"referrals">;

export const getReferralsAnalytics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => rangeSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    try {
      const { data: rows, error } = await context.supabase
        .from("referrals")
        .select(REFERRAL_ANALYTICS_COLUMNS)
        // Belt-and-braces: exclude any row marked as removed via either the
        // deleted_at timestamp OR the deleted_by attribution. A partially
        // written soft-delete (e.g. deleted_by set but deleted_at missing
        // because of a client bug or historic data) must still be filtered.
        .is("deleted_at", null)
        .is("deleted_by", null)
        // Exclude referrals explicitly flagged as test/demo entries so they
        // don't skew clinical analytics.
        .eq("is_test", false)
        .gte("referral_received_at", data.from)
        .lte("referral_received_at", data.to)
        .limit(5000);
      if (error) throw error;
      const typed = (rows ?? []) as unknown as ReferralAnalyticsRow[];
      return assertExcludesTestRows("getReferralsAnalytics", typed) as ReferralAnalyticsRow[];
    } catch (err) {
      throw safeError("analytics.getReferralsAnalytics", err, "Could not load referrals analytics.");
    }
  });

export const getPostopAnalytics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      })
      .parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    try {
      let query = context.supabase
        .from("postop_bookings")
        .select("*")
        // Belt-and-braces: exclude rows removed via either the deleted_at
        // timestamp OR the deleted_by attribution, so a partially written
        // soft-delete never leaks into analytics.
        .is("deleted_at", null)
        .is("deleted_by", null)
        // Exclude bookings explicitly flagged as test/demo entries.
        .eq("is_test", false)
        .order("created_at", { ascending: false })
        .limit(5000);
      if (data.from) query = query.gte("created_at", data.from);
      if (data.to) query = query.lte("created_at", data.to);
      const { data: rows, error } = await query;
      if (error) throw error;
      const safeRows = assertExcludesTestRows("getPostopAnalytics", rows ?? []);
      const { decryptRow } = await import("./postop-bookings-crypto.server");
      return (safeRows as Array<Record<string, any>>).map(decryptRow) as Array<Record<string, any>>;
    } catch (err) {
      throw safeError("analytics.getPostopAnalytics", err, "Could not load post-op analytics.");
    }
  });
