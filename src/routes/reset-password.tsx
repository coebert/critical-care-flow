import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { checkPassword, PASSWORD_MIN_LENGTH, PASSWORD_RULES_HINT } from "@/lib/password-policy";

export const Route = createFileRoute("/reset-password")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Reset password — SDH Critical Care" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: ResetPage,
});

function ResetPage() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fail = () => {
      if (!cancelled)
        setRecoveryError(
          "This password reset link is invalid or has expired. Please request a new one.",
        );
    };
    const succeed = () => {
      if (!cancelled) setVerified(true);
    };

    // PKCE flow: reset link arrives as /reset-password?code=...
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    const queryError =
      url.searchParams.get("error_description") || url.searchParams.get("error");

    // Legacy implicit flow: tokens arrive in the URL hash.
    const hash = window.location.hash.replace(/^#/, "");
    const hashParams = new URLSearchParams(hash);
    const hashType = hashParams.get("type");
    const accessToken = hashParams.get("access_token");
    const refreshToken = hashParams.get("refresh_token");
    const hashError =
      hashParams.get("error_description") || hashParams.get("error");

    if (queryError || hashError) {
      fail();
      return;
    }

    // Listen for the PASSWORD_RECOVERY event Supabase fires after auto-processing the link.
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") succeed();
    });

    if (code) {
      supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
        if (error) fail();
        else succeed();
      });
    } else if (hashType === "recovery" && accessToken) {
      supabase.auth
        .setSession({ access_token: accessToken, refresh_token: refreshToken ?? "" })
        .then(({ error }) => (error ? fail() : succeed()));
    } else {
      // Supabase may have auto-consumed the token before this effect ran.
      supabase.auth.getSession().then(({ data }) => {
        if (data.session) succeed();
        else setTimeout(() => { if (!cancelled && !verified) fail(); }, 1500);
      });
    }

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const check = checkPassword(password);
    if (!check.ok) return toast.error(check.problems[0]);
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setLoading(false);
      return toast.error(error.message);
    }
    // The new password becomes the wrapping key for the recipient keypair.
    // If none has been issued yet, issue it now so the user is immediately
    // reachable as an E2E recipient.
    const { ensureRecipientKey } = await import("@/lib/e2e-auto-bootstrap");
    await ensureRecipientKey(password);
    setLoading(false);
    toast.success("Password updated");
    navigate({ to: "/", replace: true });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md p-8">
        <h1 className="text-lg font-semibold mb-1">Set a new password</h1>
        <p className="text-sm text-muted-foreground mb-6">
          Choose a strong password you haven't used elsewhere.
        </p>

        {recoveryError ? (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
            {recoveryError}
          </div>
        ) : !verified ? (
          <p className="text-sm text-muted-foreground">Verifying reset link…</p>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="pw">New password</Label>
              <Input
                id="pw"
                type="password"
                required
                minLength={PASSWORD_MIN_LENGTH}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                aria-describedby="pw-help"
              />
              <p id="pw-help" className="text-[11px] text-muted-foreground leading-snug">
                {PASSWORD_RULES_HINT}
              </p>
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Updating…" : "Update password"}
            </Button>
          </form>
        )}
      </Card>
      <Toaster />
    </div>
  );
}

