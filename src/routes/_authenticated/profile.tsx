import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  AlertTriangle,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useE2ESession, useKeyStatus } from "@/hooks/use-e2e-session";
import { reissueRecipientKeypair } from "@/lib/e2e-keys.functions";
import { generateAndWrapKeypair, unwrapPrivateKey } from "@/lib/e2e-crypto";
import { E2EUnlockModal } from "@/components/e2e-unlock-modal";
import { PasskeyList } from "@/components/passkey-list";
import { RouteErrorFallback } from "@/components/route-error-fallback";
import { KeyStatusBadge, shortFingerprint } from "@/components/profile/key-status-badge";
import { ReissueKeypairDialog } from "@/components/profile/reissue-keypair-dialog";
import { VerifyKeysDialog } from "@/components/profile/verify-keys-dialog";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/profile")({
  head: () => ({
    meta: [
      { title: "Your profile — SDH Critical Care" },
      { name: "description", content: "Your account and encryption key status." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  errorComponent: ({ error }) => <RouteErrorFallback error={error} label="Profile" />,
  component: ProfilePage,
});

function ProfilePage() {
  const { user } = useAuth();
  const e2e = useE2ESession();
  const status = useKeyStatus();
  const reissue = useServerFn(reissueRecipientKeypair);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [reissueOpen, setReissueOpen] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);

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
              <KeyRound className="w-4 h-4" aria-hidden="true" /> Recipient encryption key
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
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Checking key status…
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
                <Lock className="w-4 h-4 mr-2" aria-hidden="true" /> Unlock encryption
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
              <ShieldCheck className="w-4 h-4" aria-hidden="true" /> Verify encryption keys
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
          <ShieldCheck className="w-4 h-4 mr-2" aria-hidden="true" /> Verify my keys
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
              <RefreshCw className="w-4 h-4" aria-hidden="true" /> Re-issue keypair
            </h2>
            <p className="text-xs text-muted-foreground mt-1 max-w-md">
              Use this if key issuance failed, if you've lost access to your
              previous key (e.g. forgot the password used to wrap it), or if
              you suspect the key was compromised.
            </p>
          </div>
        </div>
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive flex gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
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
          <RefreshCw className="w-4 h-4 mr-2" aria-hidden="true" /> Re-issue my keypair
        </Button>
      </Card>

      <E2EUnlockModal
        open={unlockOpen}
        onOpenChange={setUnlockOpen}
        onUnlocked={async () => { await useE2ESession.getState().refreshStatus(); }}
      />
      <ReissueKeypairDialog
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
          const priv = await unwrapPrivateKey(password, material);
          useE2ESession.setState({
            publicKey: keypair.publicKey,
            privateKey: priv,
            material,
            isUnlocked: true,
            needsBootstrap: false,
          });
          toast.success("New keypair issued");
          await useE2ESession.getState().refreshStatus();
        }}
      />
      <VerifyKeysDialog open={verifyOpen} onOpenChange={setVerifyOpen} />
    </div>
  );
}
