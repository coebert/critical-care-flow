import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, Loader2, MinusCircle, ShieldCheck, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { verifyStoredKeypair, type KeypairVerification } from "@/lib/e2e-crypto";
import { getMyPrivateKeyMaterial } from "@/lib/e2e-keys.functions";

const CHECK_LABELS: Record<keyof KeypairVerification["checks"], string> = {
  fetched_material: "Fetched stored key material",
  unwrap_private_key: "Unwrapped private key with your password",
  public_key_matches: "Private key matches the published public key",
  round_trip_encrypt_decrypt: "Round-trip encrypt → decrypt succeeded",
};

export function VerifyKeysDialog({
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
            <ShieldCheck className="w-4 h-4 text-primary" aria-hidden="true" /> Verify encryption keys
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
              {busy ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" aria-hidden="true" /> Checking…</>
              ) : "Run verification"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function VerificationResultView({ result }: { result: KeypairVerification }) {
  const entries = Object.entries(result.checks) as Array<
    [keyof KeypairVerification["checks"], KeypairVerification["checks"][keyof KeypairVerification["checks"]]]
  >;
  return (
    <div className="rounded-md border p-3 space-y-2 bg-muted/30">
      <div className="text-sm font-medium flex items-center gap-2">
        {result.ok ? (
          <><CheckCircle2 className="w-4 h-4 text-success" aria-hidden="true" /> All checks passed</>
        ) : (
          <><XCircle className="w-4 h-4 text-destructive" aria-hidden="true" /> Verification failed</>
        )}
      </div>
      <ul className="space-y-1 text-xs">
        {entries.map(([k, v]) => (
          <li key={k} className="flex items-start gap-2">
            {v === "ok" ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0 mt-0.5" aria-hidden="true" />
            ) : v === "skipped" ? (
              <MinusCircle className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" aria-hidden="true" />
            ) : (
              <XCircle className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" aria-hidden="true" />
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
