import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

/**
 * Server-side wrappers around the sign-in / reset throttle.
 *
 * The underlying `begin_auth_attempt` / `finalize_auth_attempt` RPCs are
 * executable by service_role only. The browser never chooses an attempt
 * type, an attempt ID or a success flag:
 *  - `beginPasswordSignIn` reserves a "signin" failure slot (the slot stays a
 *    failure unless success is later proven).
 *  - `recordPasswordSignInSuccess` requires a valid session; the email comes
 *    from the verified token, so a caller can only clear their own counter.
 *  - `requestPasswordReset` performs the reset itself and derives success
 *    from the provider's response.
 */

const emailSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
});

type BeginResult = {
  locked: boolean;
  attempt_id: number | null;
  retry_after_seconds?: number;
};

export type ThrottleGate = { locked: boolean; retry_after_seconds: number };

async function beginAttempt(email: string, type: "signin" | "reset"): Promise<BeginResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.rpc("begin_auth_attempt", {
    _email: email,
    _attempt_type: type,
  });
  if (error) {
    console.error("[auth-throttle] begin failed", error.code);
    throw new Error("Sign-in is temporarily unavailable. Please try again.");
  }
  return (data ?? { locked: false, attempt_id: null }) as unknown as BeginResult;
}

async function finalizeAttempt(attemptId: number | null, success: boolean) {
  if (attemptId == null) return;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin.rpc("finalize_auth_attempt", {
    _attempt_id: attemptId,
    _success: success,
  });
  if (error) console.error("[auth-throttle] finalize failed", error.code);
}

export const beginPasswordSignIn = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => emailSchema.parse(d))
  .handler(async ({ data }): Promise<ThrottleGate> => {
    const begin = await beginAttempt(data.email, "signin");
    return {
      locked: Boolean(begin.locked),
      retry_after_seconds: begin.retry_after_seconds ?? 0,
    };
  });

export const recordPasswordSignInSuccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const claims = context.claims as Record<string, unknown>;
    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    if (!email) return { ok: true };

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("auth_throttle")
      .select("id")
      .eq("email_norm", email)
      .eq("attempt_type", "signin")
      .eq("success", false)
      .order("attempted_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("[auth-throttle] lookup failed", error.code);
      return { ok: false };
    }
    // Success is proven by the verified session for this email, never by input.
    if (row) await finalizeAttempt(row.id, true);
    return { ok: true };
  });

function resetRedirectUrl(): string | undefined {
  const req = getRequest();
  const candidate = req?.headers.get("origin") ?? (req ? new URL(req.url).origin : "");
  try {
    const u = new URL(candidate);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    // The auth provider's redirect allow-list is the final check.
    return `${u.origin}/reset-password`;
  } catch {
    return undefined;
  }
}

export const requestPasswordReset = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => emailSchema.parse(d))
  .handler(async ({ data }): Promise<ThrottleGate & { sent: boolean }> => {
    const begin = await beginAttempt(data.email, "reset");
    if (begin.locked) {
      return { locked: true, retry_after_seconds: begin.retry_after_seconds ?? 0, sent: false };
    }

    const url = process.env["SUPABASE_URL"];
    const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
    if (!url || !key) throw new Error("Password reset is temporarily unavailable.");
    const client = createClient<Database>(url, key, {
      auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (input, init) => {
          const h = new Headers(init?.headers);
          if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`) {
            h.delete("Authorization");
          }
          h.set("apikey", key);
          return fetch(input, { ...init, headers: h });
        },
      },
    });

    const { error } = await client.auth.resetPasswordForEmail(data.email, {
      redirectTo: resetRedirectUrl(),
    });
    await finalizeAttempt(begin.attempt_id, !error);
    if (error) {
      console.error("[auth-throttle] reset failed", error.status);
      throw new Error("Could not send a reset link right now. Please try again shortly.");
    }
    return { locked: false, retry_after_seconds: 0, sent: true };
  });
