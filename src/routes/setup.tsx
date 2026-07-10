import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { safeError } from "@/lib/safe-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { assertSetupSecret } from "@/lib/setup-secret-guard";

// Public server fn — refuses unless (a) no users exist AND (b) a valid
// out-of-band SETUP_SECRET is provided. Without the secret set on the
// server, /setup is disabled entirely, preventing a takeover race by
// anyone who reaches the URL before the legitimate operator.
const bootstrapFirstAdmin = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        email: z.string().email().max(255),
        password: z.string().min(8).max(128),
        full_name: z.string().trim().min(1).max(120),
        setup_secret: z.string().min(1).max(256),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    // Runs BEFORE any dynamic import of supabaseAdmin — a rejection here
    // guarantees no DB or auth writes occur.
    assertSetupSecret(data.setup_secret, process.env.SETUP_SECRET);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: users, error: listErr } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1 });
    if (listErr) throw safeError("setup.listUsers", listErr, "Setup check failed.");
    if (users.users.length > 0) throw new Error("Setup already complete. Sign in instead.");

    const { error } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: { full_name: data.full_name },
    });
    if (error) throw safeError("setup.createAdmin", error, "Failed to create admin account.");
    // Trigger already creates 'admin' for the first user
    return { ok: true };
  });

// Reports whether setup is currently possible. Does NOT reveal the secret;
// only whether (a) it is configured and (b) no users exist yet.
const setupAvailability = createServerFn({ method: "GET" }).handler(async () => {
  const secretConfigured = !!(process.env.SETUP_SECRET && process.env.SETUP_SECRET.length >= 16);
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1 });
  if (error) throw safeError("setup.hasAnyUser", error, "Setup check failed.");
  return { hasUsers: data.users.length > 0, secretConfigured };
});

export const Route = createFileRoute("/setup")({
  ssr: false,
  head: () => ({ meta: [{ title: "Setup — SDH Critical Care" }, { name: "robots", content: "noindex,nofollow" }] }),
  component: SetupPage,
});

function SetupPage() {
  const navigate = useNavigate();
  const bootstrap = useServerFn(bootstrapFirstAdmin);
  const check = useServerFn(setupAvailability);
  const [checking, setChecking] = useState(true);
  const [available, setAvailable] = useState(false);
  const [secretConfigured, setSecretConfigured] = useState(false);
  const [f, setF] = useState({ email: "", password: "", full_name: "", setup_secret: "" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    check({}).then((r: any) => {
      setAvailable(!r.hasUsers && r.secretConfigured);
      setSecretConfigured(!!r.secretConfigured);
      setChecking(false);
    });
  }, [check]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await bootstrap({ data: f });
      const { error } = await supabase.auth.signInWithPassword({ email: f.email, password: f.password });
      if (error) throw error;
      const { ensureRecipientKey } = await import("@/lib/e2e-auto-bootstrap");
      await ensureRecipientKey(f.password);
      toast.success("Admin account created");
      navigate({ to: "/", replace: true });
    } catch (err: any) {
      toast.error(err.message ?? "Setup failed");
    } finally {
      setBusy(false);
    }
  };

  if (checking) return <div className="min-h-dvh flex items-center justify-center text-muted-foreground">Checking…</div>;
  if (!available) {
    return (
      <div className="min-h-dvh flex items-center justify-center p-4">
        <Card className="p-6 max-w-md">
          <h1 className="font-semibold mb-2">
            {secretConfigured ? "Setup already complete" : "Setup is disabled"}
          </h1>
          <p className="text-sm text-muted-foreground mb-4">
            {secretConfigured
              ? "An administrator already exists for this system."
              : "First-admin setup is not currently enabled on this deployment. Contact your administrator."}
          </p>
          <Button onClick={() => navigate({ to: "/auth" })} className="w-full">Go to sign in</Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md p-8">
        <h1 className="text-lg font-semibold mb-1">Create the first admin</h1>
        <p className="text-sm text-muted-foreground mb-6">
          This page only works once — it sets up the initial administrator for the system. You must supply the one-time setup secret provided out-of-band.
        </p>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5"><Label>Setup secret</Label><Input type="password" required value={f.setup_secret} onChange={(e) => setF({ ...f, setup_secret: e.target.value })} /></div>
          <div className="space-y-1.5"><Label>Full name</Label><Input required value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} /></div>
          <div className="space-y-1.5"><Label>Email</Label><Input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
          <div className="space-y-1.5"><Label>Password (min 8 chars)</Label><Input type="password" required minLength={8} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
          <Button type="submit" className="w-full" disabled={busy}>{busy ? "Creating…" : "Create admin account"}</Button>
        </form>
      </Card>
      <Toaster />
    </div>
  );
}
