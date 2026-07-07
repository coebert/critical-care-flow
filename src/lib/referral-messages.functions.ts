import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";
import { assertAdmin } from "./auth-guards";

const channelEnum = z.enum(["phone", "bleep", "email", "secure_msg", "in_person"]);
const directionEnum = z.enum(["outbound", "inbound"]);

const logSchema = z.object({
  referral_id: z.string().uuid(),
  channel: channelEnum,
  direction: directionEnum.optional(),
  recipient: z.string().trim().max(200).nullable().optional(),
  body: z.string().trim().min(1).max(4000),
  template_id: z.string().uuid().nullable().optional(),
});

export const listMessages = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ referral_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("referral_messages")
      .select("*")
      .eq("referral_id", data.referral_id)
      .order("sent_at", { ascending: false });
    if (error) throw safeError("messages", error, "Could not load messages");
    return rows ?? [];
  });

export const logMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => logSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("referral_messages")
      .insert({
        referral_id: data.referral_id,
        channel: data.channel,
        direction: data.direction ?? "outbound",
        recipient: data.recipient ?? null,
        body: data.body,
        template_id: data.template_id ?? null,
        sent_by: context.userId,
      })
      .select("*")
      .single();
    if (error) throw safeError("messages", error, "Could not log message");
    return row;
  });

export const deleteMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { error } = await context.supabase.from("referral_messages").delete().eq("id", data.id);
    if (error) throw safeError("messages", error, "Could not delete message");
    return { ok: true };
  });
