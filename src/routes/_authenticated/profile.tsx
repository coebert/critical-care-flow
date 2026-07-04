import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
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

      <Card className="p-5 space-y-3 border-destructive/30">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-2">
              <RefreshCw className="w-4 h-4" /> Re-issue keypair
            </h2>
            <p className="text-xs text-muted-foreground mt-1 max-w-md">
              Use this if key issuance failed, if you've lost access to your
              previous key (e.g. forgot the password used to wrap it), or if
              you suspect the key was compromised.
            </p>
          </div>
        </div>
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive flex gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            Re-issuing replaces your current keypair. Any encrypted notes sent
            to your old key before now will become permanently unreadable to
            you. Teammates can still read notes you wrote to them.
          </span>
        </div>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setReissueOpen(true)}
          disabled={status === "loading"}
        >
          <RefreshCw className="w-4 h-4 mr-2" /> Re-issue my keypair
        </Button>
      </Card>

      <E2EUnlockModal open={unlockOpen} onOpenChange={setUnlockOpen} />
      <ReissueDialog
        open={reissueOpen}
        onOpenChange={setReissueOpen}
        onConfirm={async (password) => {
          const { keypair, material } = await generateAndWrapKeypair(password);
          await reissue({
            data: {
              password,
              public_key: keypair.publicKey,
              encrypted_private_key: material.encrypted_private_key,
              kdf_salt: material.kdf_salt,
              kdf_ops: material.kdf_ops,
              kdf_mem: material.kdf_mem,
              nonce: material.nonce,
            },
          });
          // Unlock immediately so the user sees "Ready" without another prompt.
          const priv = await unwrapPrivateKey(password, material);
          useE2ESession.setState({
            publicKey: keypair.publicKey,
            privateKey: priv,
            material,
            isUnlocked: true,
            needsBootstrap: false,
          });
          toast.success("New keypair issued");
        }}
      />
    </div>
  );
}

function ReissueDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const canSubmit = password.length >= 8 && confirmText.trim().toUpperCase() === "REISSUE" && !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onConfirm(password);
      onOpenChange(false);
      setPassword("");
      setConfirmText("");
    } catch (err: any) {
      toast.error(err?.message ?? "Re-issue failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Re-issue recipient keypair</DialogTitle>
          <DialogDescription>
            Confirm your account password to prove it's you. Your new password
            (same value, unless you also reset it) becomes the wrapping key
            for the new private key.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="reissue-pw">Current password</Label>
            <Input
              id="reissue-pw"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reissue-confirm">
              Type <span className="font-mono">REISSUE</span> to confirm
            </Label>
            <Input
              id="reissue-confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="REISSUE"
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={!canSubmit}>
              {busy ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Issuing…</> : "Re-issue keypair"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
