import { useState, type ReactNode } from "react";
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
import { useE2ESession } from "@/hooks/use-e2e-session";
import { publishUserKeys } from "@/lib/e2e-keys.functions";
import { toast } from "sonner";

export function E2EUnlockModal({
  open,
  onOpenChange,
  onUnlocked,
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onUnlocked?: () => void;
  children?: ReactNode;
}) {
  const { unlock, bootstrap, needsBootstrap, material } = useE2ESession();
  const publish = useServerFn(publishUserKeys);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const isBootstrap = needsBootstrap && !material;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    if (isBootstrap && password !== confirm) {
      toast.error("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      if (isBootstrap) {
        await bootstrap(password, (m) => publish({ data: m }));
        toast.success("End-to-end encryption enabled.");
      } else {
        await unlock(password);
        toast.success("Notes unlocked.");
      }
      setPassword("");
      setConfirm("");
      onOpenChange(false);
      onUnlocked?.();
    } catch (err: any) {
      toast.error(err?.message ?? "Could not unlock notes.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
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
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="e2e-pw">Password</Label>
            <Input
              id="e2e-pw"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
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
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </div>
          )}
          {children}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !password}>
              {busy
                ? isBootstrap
                  ? "Enabling…"
                  : "Unlocking…"
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
