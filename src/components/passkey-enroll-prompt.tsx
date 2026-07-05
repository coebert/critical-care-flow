import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Fingerprint, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { registerPasskey, setPasskeyEnrollDismissed, snoozePasskeyEnroll } from "@/lib/passkeys";

export function PasskeyEnrollPrompt({
  open,
  onOpenChange,
  onEnrolled,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onEnrolled?: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const enable = async () => {
    setBusy(true);
    try {
      await registerPasskey();
      toast.success("Passkey set up — next time, sign in with your fingerprint or face.");
      onEnrolled?.();
      onOpenChange(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not set up passkey";
      // NotAllowedError = user cancelled the prompt; don't yell.
      if (err instanceof Error && err.name === "NotAllowedError") {
        toast.message("Passkey setup cancelled");
      } else {
        toast.error(msg);
      }
    } finally {
      setBusy(false);
    }
  };

  const dontAskAgain = () => {
    setPasskeyEnrollDismissed(true);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v); }}>
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
              <Fingerprint className="w-5 h-5 text-primary" />
            </div>
            <div>
              <DialogTitle>Sign in faster with a passkey</DialogTitle>
              <DialogDescription>
                Use Face ID, Touch ID, or your device PIN instead of a password.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <div className="text-sm text-muted-foreground space-y-2">
          <p>
            A passkey is stored securely on this device (and, if you use iCloud
            Keychain or Google Password Manager, synced to your other devices).
            Your password still works as a fallback.
          </p>
        </div>
        <DialogFooter className="flex-col-reverse sm:flex-row sm:justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={dontAskAgain} disabled={busy}>
            Don't ask again on this device
          </Button>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => { snoozePasskeyEnroll(); onOpenChange(false); }} disabled={busy}>
              Not now
            </Button>
            <Button onClick={enable} disabled={busy}>
              {busy ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Setting up…
                </>
              ) : (
                <>
                  <Fingerprint className="w-4 h-4 mr-2" /> Set up passkey
                </>
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
