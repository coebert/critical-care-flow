import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Activity } from "lucide-react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { retrySupabaseCall, retryWithBackoff } from "@/lib/retry";

export const Route = createFileRoute("/auth")({
  ssr: false,
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
  const [mode, setMode] = useState<"signin" | "forgot">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/", replace: true });
    });
  }, [navigate]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        toast.success("Signed in");
        navigate({ to: "/", replace: true });
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin + "/reset-password",
        });
        if (error) throw error;
        toast.success("Password reset email sent");
        setMode("signin");
      }
    } catch (err: any) {
      toast.error(err.message ?? "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
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
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Please wait…" : mode === "signin" ? "Sign in" : "Send reset link"}
          </Button>
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
      <Toaster />
    </div>
  );
}
