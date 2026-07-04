import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { KeyRound, ShieldCheck, ShieldAlert, Lock, Loader2, RefreshCw, AlertTriangle } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useE2ESession } from "@/hooks/use-e2e-session";
import { getMyPrivateKeyMaterial, reissueRecipientKeypair } from "@/lib/e2e-keys.functions";
import { generateAndWrapKeypair, unwrapPrivateKey } from "@/lib/e2e-crypto";
import { E2EUnlockModal } from "@/components/e2e-unlock-modal";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/profile")({
  head: () => ({
    meta: [
      { title: "Your profile — SDH Critical Care" },
      { name: "description", content: "Your account and encryption key status." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: ProfilePage,
});

type Status = "loading" | "ready" | "locked" | "not_issued";

function ProfilePage() {
  const { user } = useAuth();
  const e2e = useE2ESession();
  const fetchKeyMaterial = useServerFn(getMyPrivateKeyMaterial);
  const reissue = useServerFn(reissueRecipientKeypair);
  const [status, setStatus] = useState<Status>("loading");
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [reissueOpen, setReissueOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!e2e.hydrated) await e2e.hydrateFromSession();
        const res: any = await fetchKeyMaterial({ data: undefined as any });
        if (cancelled) return;
        e2e.setMaterial(res?.material ?? null, res?.public_key ?? null);
        if (!res?.material || !res?.public_key) setStatus("not_issued");
        else if (useE2ESession.getState().isUnlocked) setStatus("ready");
        else setStatus("locked");
      } catch {
        if (!cancelled) setStatus("not_issued");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Reflect live unlock changes (e.g. after using the unlock modal).
  useEffect(() => {
    if (status === "loading") return;
    if (e2e.needsBootstrap || (!e2e.material && !e2e.publicKey)) {
      setStatus("not_issued");
    } else if (e2e.isUnlocked) {
      setStatus("ready");
    } else {
      setStatus("locked");
    }
  }, [e2e.isUnlocked, e2e.material, e2e.publicKey, e2e.needsBootstrap, status]);

  const publicKey = e2e.publicKey;
  const fingerprint = publicKey ? shortFingerprint(publicKey) : null;

  return (
    <div className="max-w-2xl mx-auto p-4 sm:p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Your profile</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Account details and end-to-end encryption status.
        </p>
      </div>

      <Card className="p-5 space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Account
        </h2>
        <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <div className="text-muted-foreground">Email</div>
          <div className="font-mono">{user?.email ?? "—"}</div>
          <div className="text-muted-foreground">User ID</div>
          <div className="font-mono text-xs break-all">{user?.id ?? "—"}</div>
        </div>
      </Card>

      <Card className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-2">
              <KeyRound className="w-4 h-4" /> Recipient encryption key
            </h2>
            <p className="text-xs text-muted-foreground mt-1">
              Teammates use this key to send you end-to-end encrypted notes.
              Without it, they cannot include you as a recipient.
            </p>
          </div>
          <KeyStatusBadge status={status} />
        </div>

        <div className="text-sm">
          {status === "loading" && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> Checking key status…
            </div>
          )}
          {status === "ready" && (
            <div className="space-y-2">
              <p className="text-success">
                Your keypair is issued and unlocked in this browser tab. You
                can send and receive encrypted notes.
              </p>
              {fingerprint && (
                <div className="text-xs text-muted-foreground">
                  Public key fingerprint:{" "}
                  <span className="font-mono">{fingerprint}</span>
                </div>
              )}
            </div>
          )}
          {status === "locked" && (
            <div className="space-y-3">
              <p>
                Your keypair is issued but locked in this tab. Unlock it with
                your password to read and write encrypted notes.
              </p>
              {fingerprint && (
                <div className="text-xs text-muted-foreground">
                  Public key fingerprint:{" "}
                  <span className="font-mono">{fingerprint}</span>
                </div>
              )}
              <Button size="sm" onClick={() => setUnlockOpen(true)}>
                <Lock className="w-4 h-4 mr-2" /> Unlock now
              </Button>
            </div>
          )}
          {status === "not_issued" && (
            <div className="space-y-3">
              <p className="text-destructive">
                No recipient key has been issued yet. Teammates cannot include
                you on encrypted notes until you enable encryption.
              </p>
              <p className="text-xs text-muted-foreground">
                Sign out and sign in again with your password to have a
                keypair issued automatically, or enable it now.
              </p>
              <Button size="sm" onClick={() => setUnlockOpen(true)}>
                Enable encryption
              </Button>
            </div>
          )}
        </div>
      </Card>

      <E2EUnlockModal open={unlockOpen} onOpenChange={setUnlockOpen} />
    </div>
  );
}

function KeyStatusBadge({ status }: { status: Status }) {
  if (status === "ready") {
    return (
      <Badge className="bg-success text-success-foreground gap-1">
        <ShieldCheck className="w-3.5 h-3.5" /> Ready
      </Badge>
    );
  }
  if (status === "locked") {
    return (
      <Badge variant="secondary" className="gap-1">
        <Lock className="w-3.5 h-3.5" /> Locked
      </Badge>
    );
  }
  if (status === "not_issued") {
    return (
      <Badge variant="destructive" className="gap-1">
        <ShieldAlert className="w-3.5 h-3.5" /> Not issued
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1">
      <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking
    </Badge>
  );
}

function shortFingerprint(publicKeyB64: string): string {
  // Purely presentational: a stable short hash-ish view of the key so users
  // can eyeball match with a teammate's device without exposing the full key.
  const s = publicKeyB64.replace(/[^A-Za-z0-9]/g, "");
  if (s.length <= 16) return s;
  return `${s.slice(0, 8)}…${s.slice(-8)}`;
}
