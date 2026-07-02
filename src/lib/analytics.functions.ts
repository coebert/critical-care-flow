import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";


async function assertAdmin(context: any) {
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

const rangeSchema = z
  .object({
    from: z.string().datetime(),
    to: z.string().datetime(),
  })
  .refine((r) => new Date(r.from) <= new Date(r.to), {
    message: "from must be <= to",
  });

export const getReferralsAnalytics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => rangeSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    try {
      const { data: rows, error } = await context.supabase
        .from("referrals")
        .select("*")
        .is("deleted_at", null)
        .gte("referral_received_at", data.from)
        .lte("referral_received_at", data.to)
        .limit(5000);
      if (error) throw error;
      return rows ?? [];
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
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(5000);
      if (data.from) query = query.gte("created_at", data.from);
      if (data.to) query = query.lte("created_at", data.to);
      const { data: rows, error } = await query;
      if (error) throw error;
      return (rows ?? []).map(decryptRow);
    } catch (err) {
      throw safeError("analytics.getPostopAnalytics", err, "Could not load post-op analytics.");
    }
  });
