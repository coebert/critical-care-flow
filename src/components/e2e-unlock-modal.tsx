import { useEffect, useState, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useE2ESession } from "@/hooks/use-e2e-session";
import { publishUserKeys } from "@/lib/e2e-keys.functions";
import { toast } from "sonner";
import { AlertCircle, Loader2, ShieldCheck } from "lucide-react";
import { friendlyE2EError, type FriendlyE2EError } from "@/lib/friendly-e2e-error";

const MIN_PASSWORD = 8;

export function E2EUnlockModal({
  open,
  onOpenChange,
  onUnlocked,
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onUnlocked?: () => void | Promise<void>;
  children?: ReactNode;
}) {
  const { unlock, bootstrap, needsBootstrap, material } = useE2ESession();
  const publish = useServerFn(publishUserKeys);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"idle" | "deriving" | "finalizing">("idle");
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);

  const isBootstrap = needsBootstrap && !material;

  // Reset transient UI whenever the modal opens or the mode changes.
  useEffect(() => {
    if (open) {
      setError(null);
      setStatus("idle");
    } else {
      setPassword("");
      setConfirm("");
      setAttempts(0);
      setError(null);
      setStatus("idle");
    }
  }, [open, isBootstrap]);

  const clearErrorOnEdit = () => {
    if (error) setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    if (isBootstrap && password.length < MIN_PASSWORD) {
      setError(`Please choose a password with at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (isBootstrap && password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    setStatus("deriving");
    try {
      if (isBootstrap) {
        await bootstrap(password, async (m) => {
          setStatus("finalizing");
          // User-driven bootstrap from the unlock modal → audit as "enable"
          // (vs the sign-in auto-bootstrap, which audits as "issue").
          return publish({ data: { ...m, source: "enable" as const } });
        });
        toast.success("End-to-end encryption enabled.");
      } else {
        await unlock(password);
        setStatus("finalizing");
        toast.success("Notes unlocked.");
      }
      // Await the caller so the modal only closes after notes actually refresh.
      try {
        await onUnlocked?.();
      } catch {
        /* the caller surfaces its own errors; unlock itself succeeded */
      }
      setPassword("");
      setConfirm("");
      setAttempts(0);
      onOpenChange(false);
    } catch (err) {
      setAttempts((a) => a + 1);
      setError(friendlyUnlockError(err, isBootstrap));
      // Keep the modal open and the password field populated for a quick retry.
    } finally {
      setBusy(false);
      setStatus("idle");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (busy ? null : onOpenChange(v))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-primary" />
            {isBootstrap ? "Enable end-to-end encryption" : "Unlock encrypted notes"}
          </DialogTitle>
          <DialogDescription>
            {isBootstrap
              ? "Enter your account password to generate an encryption key. Your password never leaves this browser and is used to protect the key that decrypts note messages sent to you."
              : "Enter your account password to unlock notes for this session. Your password never leaves this browser."}
          </DialogDescription>
        </DialogHeader>
        {isBootstrap && (
          <p className="text-xs rounded border border-amber-500/40 bg-amber-500/10 p-2 text-amber-800 dark:text-amber-200">
            Warning: because this is end-to-end encryption, nobody — including
            admins — can recover your notes if you forget this password. If you
            reset your password later, any notes sent to you before that point
            become unreadable.
          </p>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="w-4 h-4" />
            <AlertTitle>
              {isBootstrap ? "Couldn't enable encryption" : "Couldn't unlock"}
              {attempts > 1 ? ` (attempt ${attempts})` : ""}
            </AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="e2e-pw">Password</Label>
            <Input
              id="e2e-pw"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); clearErrorOnEdit(); }}
              required
              autoFocus
              disabled={busy}
            />
          </div>
          {isBootstrap && (
            <div className="space-y-1.5">
              <Label htmlFor="e2e-pw2">Confirm password</Label>
              <Input
                id="e2e-pw2"
                type="password"
                autoComplete="current-password"
                value={confirm}
                onChange={(e) => { setConfirm(e.target.value); clearErrorOnEdit(); }}
                required
                disabled={busy}
              />
            </div>
          )}
          {children}
          {busy && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {status === "deriving"
                ? "Deriving key from your password (this can take a moment)…"
                : "Refreshing your notes…"}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !password || (isBootstrap && !confirm)}>
              {busy
                ? isBootstrap
                  ? "Enabling…"
                  : "Unlocking…"
                : error
                  ? "Try again"
                  : isBootstrap
                    ? "Enable encryption"
                    : "Unlock"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
