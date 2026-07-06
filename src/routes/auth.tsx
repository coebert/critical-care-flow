import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Activity, Fingerprint, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { retrySupabaseCall, retryWithBackoff } from "@/lib/retry";
import { ensureRecipientKey } from "@/lib/e2e-auto-bootstrap";
import {
  isPasskeySupported,
  isPlatformAuthenticatorAvailable,
  NO_PASSKEY_REGISTERED,
  passkeyEnrollDismissed,
  signInWithPasskey,
} from "@/lib/passkeys";
import { listMyPasskeys } from "@/lib/webauthn.functions";
import { PasskeyEnrollPrompt } from "@/components/passkey-enroll-prompt";

// When "Keep me signed in" is unchecked, move the persisted Supabase auth token
// from localStorage to sessionStorage so the session ends when the browser closes.
function downgradeSessionToTabOnly() {
  if (typeof window === "undefined") return;
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key) continue;
      if (key.startsWith("sb-") && key.endsWith("-auth-token")) {
        const value = window.localStorage.getItem(key);
        if (value !== null) {
          window.sessionStorage.setItem(key, value);
          window.localStorage.removeItem(key);
        }
        break;
      }
    }
  } catch {
    // Storage access can fail in private modes — best-effort only.
  }
}

export const Route = createFileRoute("/auth")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>) => {
    const raw = typeof search.redirect === "string" ? search.redirect : "";
    // Only accept same-origin relative paths to prevent open redirects.
    const safe = raw.startsWith("/") && !raw.startsWith("//") ? raw : "";
    return { redirect: safe };
  },
  head: () => ({
    meta: [
      { title: "Sign in — SDH Critical Care" },
      { name: "description", content: "Sign in to the Salisbury District Hospital critical care referral tracker." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const { redirect: redirectTo } = Route.useSearch();
  const postAuthTarget = redirectTo || "/";
  const [mode, setMode] = useState<"signin" | "forgot">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [passkeySupported, setPasskeySupported] = useState(false);
  const [enrollPromptOpen, setEnrollPromptOpen] = useState(false);
  // Set when the user tried biometric sign-in but no passkey is registered yet.
  // After they complete password sign-in we force-open the enrolment modal so
  // they can set one up in the same flow.
  const [enrollAfterSignIn, setEnrollAfterSignIn] = useState(false);

  useEffect(() => {
    setPasskeySupported(isPasskeySupported());
  }, []);




  useEffect(() => {
    let cancelled = false;
    retryWithBackoff(() => supabase.auth.getSession().then((r) => {
      if (r.error) throw r.error;
      return r.data;
    }))
      .then((data) => {
        if (!cancelled && data.session) navigate({ to: postAuthTarget, replace: true });
      })
      .catch(() => {
        // Transient failure restoring session — let the user sign in manually.
      });
    return () => {
      cancelled = true;
    };
  }, [navigate, postAuthTarget]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const attemptType: "signin" | "reset" = mode === "signin" ? "signin" : "reset";
    let notifiedRetry = false;
    let attemptId: number | null = null;
    try {
      // Atomic check + reserve. Concurrent submissions for the same email serialize
      // server-side via pg_advisory_xact_lock; only attempts under the threshold get
      // an attempt_id back, the rest are told they're locked out.
      const { data: beginData, error: beginErr } = await supabase.rpc("begin_auth_attempt", {
        _email: email,
        _attempt_type: attemptType,
      });
      if (beginErr) throw beginErr;
      const begin = beginData as { locked: boolean; attempt_id: number | null; retry_after_seconds?: number };
      if (begin?.locked) {
        const secs = begin.retry_after_seconds ?? 0;
        const mins = Math.max(1, Math.ceil(secs / 60));
        toast.error(`Too many failed attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`);
        return;
      }
      attemptId = begin?.attempt_id ?? null;

      if (mode === "signin") {
        const { error } = await retrySupabaseCall(
          () => supabase.auth.signInWithPassword({ email, password }),
          {
            onRetry: (_err, attempt) => {
              if (!notifiedRetry) {
                notifiedRetry = true;
                toast.message("Network hiccup — retrying sign in…");
              }
              console.warn(`[auth] sign-in retry attempt ${attempt}`);
            },
          },
        );
        if (error) {
          if (attemptId !== null) {
            await supabase.rpc("finalize_auth_attempt", { _attempt_id: attemptId, _success: false });
          }
          attemptId = null;
          throw error;
        }
        if (attemptId !== null) {
          await supabase.rpc("finalize_auth_attempt", { _attempt_id: attemptId, _success: true });
        }
        attemptId = null;
        if (!rememberMe) downgradeSessionToTabOnly();
        // Automatically issue a recipient keypair on first successful sign-in.
        await ensureRecipientKey(password);
        toast.success("Signed in");
        // If the user just tried biometric sign-in and had no passkey, always
        // offer enrolment now regardless of the "don't ask again" preference.
        const shouldPrompt = enrollAfterSignIn || (await shouldPromptForPasskey());
        if (shouldPrompt) {
          setEnrollPromptOpen(true);
          return; // navigation deferred until the modal closes
        }
        navigate({ to: postAuthTarget, replace: true });
      } else {
        const { error } = await retrySupabaseCall(() =>
          supabase.auth.resetPasswordForEmail(email, {
            redirectTo: window.location.origin + "/reset-password",
          }),
        );
        if (attemptId !== null) {
          await supabase.rpc("finalize_auth_attempt", { _attempt_id: attemptId, _success: !error });
        }
        attemptId = null;
        if (error) throw error;
        toast.success("If that email exists, a password reset link has been sent.");
        setMode("signin");
      }
    } catch (err: any) {
      // If we reserved a slot but never finalized (e.g. network error during auth),
      // leave it as failed — better to over-count than under-count during a brute-force burst.
      toast.error(err?.message ?? "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  const handlePasskeySignIn = async () => {
    const trimmed = email.trim();
    if (!trimmed) {
      toast.error("Enter your email address first");
      return;
    }
    setPasskeyBusy(true);
    try {
      await signInWithPasskey(trimmed);
      if (!rememberMe) downgradeSessionToTabOnly();
      toast.success("Signed in with passkey");
      navigate({ to: postAuthTarget, replace: true });
    } catch (err: unknown) {
      const code = (err as { code?: string } | null)?.code;
      if (code === NO_PASSKEY_REGISTERED) {
        // No passkey on file for this email — flip into password mode and
        // auto-open the enrolment modal after a successful password sign-in.
        setEnrollAfterSignIn(true);
        setMode("signin");
        toast.message(
          "No passkey found — sign in with your password and we'll set one up.",
        );
        // Give the user a clear next step by focusing the password field.
        setTimeout(() => {
          document.getElementById("password")?.focus();
        }, 0);
      } else if (err instanceof Error && err.name === "NotAllowedError") {
        toast.message("Passkey sign-in cancelled");
      } else {
        toast.error(err instanceof Error ? err.message : "Passkey sign-in failed");
      }
    } finally {
      setPasskeyBusy(false);
    }
  };

  const finishAfterEnroll = () => {
    setEnrollPromptOpen(false);
    navigate({ to: postAuthTarget, replace: true });
  };



  return (
    <div className="min-h-dvh flex flex-col bg-background">
      <main className="flex-1 flex items-center justify-center p-4">
        <Card className="w-full max-w-md p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-md bg-primary flex items-center justify-center">
              <Activity className="w-5 h-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="font-semibold leading-tight">SDH Critical Care</h1>
              <p className="text-xs text-muted-foreground">Referral tracker</p>
            </div>
          </div>
          <h2 className="text-lg font-semibold mb-1">
            {mode === "signin" ? "Sign in" : "Reset password"}
          </h2>
          <p className="text-sm text-muted-foreground mb-6">
            {mode === "signin"
              ? "Access is restricted to invited critical care team members."
              : "Enter your email and we'll send a reset link."}
          </p>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
            </div>
            {mode === "signin" && (
              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <Input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
              </div>
            )}
            {mode === "signin" && (
              <div className="flex items-start gap-2">
                <Checkbox
                  id="remember-me"
                  checked={rememberMe}
                  onCheckedChange={(v) => setRememberMe(v === true)}
                />
                <div className="grid gap-0.5 leading-none">
                  <Label htmlFor="remember-me" className="text-sm font-normal cursor-pointer">
                    Keep me signed in
                  </Label>
                  <p className="text-[11px] text-muted-foreground">
                    Stay logged in on this device. Uncheck on shared computers — your session will end when you close the browser.
                  </p>
                </div>
              </div>
            )}
            <Button type="submit" className="w-full" disabled={loading || passkeyBusy}>
              {loading ? "Please wait…" : mode === "signin" ? "Sign in" : "Send reset link"}
            </Button>
            {mode === "signin" && passkeySupported && (
              <>
                <div className="relative py-1">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-[11px] uppercase tracking-wide">
                    <span className="bg-card px-2 text-muted-foreground">or</span>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={handlePasskeySignIn}
                  disabled={loading || passkeyBusy}
                >
                  {passkeyBusy ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Verifying…
                    </>
                  ) : (
                    <>
                      <Fingerprint className="w-4 h-4 mr-2" /> Sign in with a passkey
                    </>
                  )}
                </Button>
              </>
            )}
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground underline w-full text-center"
              onClick={() => setMode(mode === "signin" ? "forgot" : "signin")}
            >
              {mode === "signin" ? "Forgot your password?" : "Back to sign in"}
            </button>
          </form>
          <p className="text-[11px] text-muted-foreground mt-6 leading-snug">
            Internal NHS use only. Data is encrypted in transit and at rest. Do not use this system with patient-identifiable data until your trust's IG team has approved it.
          </p>
        </Card>
      </main>
      <footer className="border-t bg-card/50">
        <div className="mx-auto max-w-3xl px-4 py-3 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
          <a href="/clinical-safety" className="hover:text-foreground hover:underline">Clinical safety</a>
          <a href="/privacy" className="hover:text-foreground hover:underline">Privacy notice</a>
          <a href="/security" className="hover:text-foreground hover:underline">Security disclosure</a>
        </div>
      </footer>
      <PasskeyEnrollPrompt
        open={enrollPromptOpen}
        onOpenChange={(v) => {
          if (!v) finishAfterEnroll();
          else setEnrollPromptOpen(v);
        }}
        onEnrolled={finishAfterEnroll}
      />
      <Toaster />
    </div>
  );
}

async function shouldPromptForPasskey(): Promise<boolean> {
  if (!isPasskeySupported()) return false;
  if (passkeyEnrollDismissed()) return false;
  try {
    const hasPlatform = await isPlatformAuthenticatorAvailable();
    if (!hasPlatform) return false;
    const { passkeys } = await listMyPasskeys();
    return passkeys.length === 0;
  } catch {
    return false;
  }
}

