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
import { KeyRound, ShieldCheck, ShieldAlert, Lock, Loader2, RefreshCw, AlertTriangle, CheckCircle2, XCircle, MinusCircle } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useE2ESession, useKeyStatus, type KeyStatus } from "@/hooks/use-e2e-session";
import { getMyPrivateKeyMaterial, reissueRecipientKeypair } from "@/lib/e2e-keys.functions";
import { generateAndWrapKeypair, unwrapPrivateKey, verifyStoredKeypair, type KeypairVerification } from "@/lib/e2e-crypto";
import { E2EUnlockModal } from "@/components/e2e-unlock-modal";
import { toast } from "sonner";
import { PasskeyList } from "@/components/passkey-list";

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

type Status = KeyStatus;

function ProfilePage() {
  const { user } = useAuth();
  const e2e = useE2ESession();
  const status = useKeyStatus();
  const reissue = useServerFn(reissueRecipientKeypair);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [reissueOpen, setReissueOpen] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);

  // The authenticated shell kicks off the initial refresh; re-run whenever
  // the signed-in user changes (e.g. sign-out + sign-in in the same tab).
  useEffect(() => {
    if (!user?.id) return;
    useE2ESession.getState().refreshStatus().catch(() => { /* non-fatal */ });
  }, [user?.id]);

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

      <PasskeyList />

      <Card className="p-5 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-2">
              <ShieldCheck className="w-4 h-4" /> Verify encryption keys
            </h2>
            <p className="text-xs text-muted-foreground mt-1 max-w-md">
              Confirm the encryption key stored for your account can still be
              unlocked with your password and that it round-trips a full
              encrypt/decrypt cycle. Nothing is changed — this is a read-only
              health check you can run any time.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setVerifyOpen(true)}
          disabled={status === "loading" || status === "not_issued"}
        >
          <ShieldCheck className="w-4 h-4 mr-2" /> Verify my keys
        </Button>
        {status === "not_issued" && (
          <p className="text-xs text-muted-foreground">
            You need to enable encryption before there's anything to verify.
          </p>
        )}
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

      <E2EUnlockModal
        open={unlockOpen}
        onOpenChange={setUnlockOpen}
        onUnlocked={async () => { await useE2ESession.getState().refreshStatus(); }}
      />
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
          // Re-sync from the server so status/fingerprint reflect the new key
          // immediately, not on the next mount.
          await useE2ESession.getState().refreshStatus();
        }}
      />
      <VerifyKeysDialog open={verifyOpen} onOpenChange={setVerifyOpen} />
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

function VerifyKeysDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const fetchMaterial = useServerFn(getMyPrivateKeyMaterial);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<KeypairVerification | null>(null);

  // Reset transient state on close so a stale result never leaks between opens.
  useEffect(() => {
    if (!open) {
      setPassword("");
      setBusy(false);
      setResult(null);
    }
  }, [open]);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const res: any = await fetchMaterial();
      const material = (res?.material ?? null) as any;
      const publicKey = (res?.public_key ?? null) as string | null;
      const verification = await verifyStoredKeypair(password, material, publicKey);
      setResult(verification);
      if (verification.ok) {
        toast.success("Encryption keys verified — everything decrypts correctly.");
      }
    } catch (err: any) {
      setResult({
        ok: false,
        publicKey: null,
        checks: {
          fetched_material: "error",
          unwrap_private_key: "skipped",
          public_key_matches: "skipped",
          round_trip_encrypt_decrypt: "skipped",
        },
        error: err?.message ?? String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-primary" /> Verify encryption keys
          </DialogTitle>
          <DialogDescription>
            Enter your account password to run a full check: fetch stored key
            material, unwrap the private key, confirm it pairs with the
            published public key, and round-trip encrypt/decrypt a probe.
            Nothing is changed.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={run} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="verify-pw">Password</Label>
            <Input
              id="verify-pw"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
              disabled={busy}
            />
          </div>
          {result && <VerificationResultView result={result} />}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Close
            </Button>
            <Button type="submit" disabled={busy || !password}>
              {busy ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Checking…</> : "Run verification"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const CHECK_LABELS: Record<keyof KeypairVerification["checks"], string> = {
  fetched_material: "Fetched stored key material",
  unwrap_private_key: "Unwrapped private key with your password",
  public_key_matches: "Private key matches the published public key",
  round_trip_encrypt_decrypt: "Round-trip encrypt → decrypt succeeded",
};

function VerificationResultView({ result }: { result: KeypairVerification }) {
  const entries = Object.entries(result.checks) as Array<
    [keyof KeypairVerification["checks"], KeypairVerification["checks"][keyof KeypairVerification["checks"]]]
  >;
  return (
    <div className="rounded-md border p-3 space-y-2 bg-muted/30">
      <div className="text-sm font-medium flex items-center gap-2">
        {result.ok ? (
          <><CheckCircle2 className="w-4 h-4 text-success" /> All checks passed</>
        ) : (
          <><XCircle className="w-4 h-4 text-destructive" /> Verification failed</>
        )}
      </div>
      <ul className="space-y-1 text-xs">
        {entries.map(([k, v]) => (
          <li key={k} className="flex items-start gap-2">
            {v === "ok" ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0 mt-0.5" />
            ) : v === "skipped" ? (
              <MinusCircle className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
            ) : (
              <XCircle className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" />
            )}
            <span className={v === "ok" ? "" : v === "skipped" ? "text-muted-foreground" : "text-destructive"}>
              {CHECK_LABELS[k]}
              {v !== "ok" && v !== "skipped" && (
                <span className="ml-1 font-mono uppercase text-[10px]">({v.replace(/_/g, " ")})</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {!result.ok && (
        <div className="text-xs text-muted-foreground pt-1 border-t">
          {result.checks.unwrap_private_key === "wrong_password" && (
            <>That password didn't unwrap your stored key. Try the password you used when you enabled encryption. If you've forgotten it, open <span className="font-medium">Re-issue keypair</span> below.</>
          )}
          {result.checks.public_key_matches === "mismatch" && (
            <>Your private key doesn't pair with the published public key. This usually means the key was re-issued on another device — sign out and back in to pick up the current keypair, or re-issue here.</>
          )}
          {result.checks.round_trip_encrypt_decrypt !== "ok" && result.checks.public_key_matches === "ok" && (
            <>Unwrap and pairing succeeded, but the encrypt/decrypt round-trip failed. Refresh the page and try again — if it still fails, re-issue your keypair.</>
          )}
          {result.checks.fetched_material !== "ok" && (
            <>Couldn't retrieve your stored key material. Check your connection and try again.</>
          )}
          {result.error && (
            <div className="mt-1 font-mono text-[10px] break-all opacity-70">{result.error}</div>
          )}
        </div>
      )}
    </div>
  );
}
