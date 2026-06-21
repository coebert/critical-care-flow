import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";

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
    // Recovery links from Lovable Cloud auth arrive as:
    // /reset-password#type=recovery&access_token=...&refresh_token=...
    const hash = window.location.hash.replace(/^#/, "");
    const params = new URLSearchParams(hash);
    const type = params.get("type");
    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");

    if (type !== "recovery" || !accessToken) {
      setRecoveryError(
        "This password reset link is invalid or has expired. Please request a new one."
      );
      return;
    }

    // Establish the temporary recovery session so updateUser can set the password.
    supabase.auth
      .setSession({
        access_token: accessToken,
        refresh_token: refreshToken ?? "",
      })
      .then(({ error }) => {
        if (error) {
          setRecoveryError(
            "This password reset link is invalid or has expired. Please request a new one."
          );
          return;
        }
        setVerified(true);
      });
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) return toast.error("Password must be at least 8 characters");
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) return toast.error(error.message);
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
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
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

