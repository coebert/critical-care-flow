import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";
import { assertAdmin } from "./auth-guards";

const categoryEnum = z.enum(["decline", "advice", "plan", "handover"]);

const upsertSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(120),
  category: categoryEnum,
  body: z.string().trim().min(1).max(4000),
  active: z.boolean().optional(),
});

export const listTemplates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ category: categoryEnum.optional(), include_inactive: z.boolean().optional() }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase.from("message_templates").select("*").order("title", { ascending: true });
    if (data.category) q = q.eq("category", data.category);
    if (!data.include_inactive) q = q.eq("active", true);
    const { data: rows, error } = await q;
    if (error) throw safeError("templates", error, "Could not load templates");
    return rows ?? [];
  });

export const upsertTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const payload = {
      title: data.title,
      category: data.category,
      body: data.body,
      active: data.active ?? true,
    };
    if (data.id) {
      const { data: row, error } = await context.supabase
        .from("message_templates")
        .update(payload)
        .eq("id", data.id)
        .select("*")
        .single();
      if (error) throw safeError("templates", error, "Could not update template");
      return row;
    }
    const { data: row, error } = await context.supabase
      .from("message_templates")
      .insert({ ...payload, created_by: context.userId })
      .select("*")
      .single();
    if (error) throw safeError("templates", error, "Could not create template");
    return row;
  });

export const deleteTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { error } = await context.supabase.from("message_templates").delete().eq("id", data.id);
    if (error) throw safeError("templates", error, "Could not delete template");
    return { ok: true };
  });
