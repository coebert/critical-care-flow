import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertCircle, Lock, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { E2EUnlockModal } from "@/components/e2e-unlock-modal";
import { useE2ESession } from "@/hooks/use-e2e-session";

/**
 * Top-of-app recovery surface for encryption unlock failures. Renders
 * whenever the session is `locked` (material exists but never got unwrapped
 * this tab) or a persistent auto-unlock error is on record. Gives the user
 * three always-visible next steps so they never end up staring at a stale
 * "encryption not ready" state:
 *   • Retry — opens the unlock modal (a fresh password attempt).
 *   • Re-issue keypair — deep-links to Profile for the corrupt-material path.
 *   • Dismiss — hides the banner this session (status changes reset it).
 *
 * The modal itself handles per-attempt error messaging + retry-in-place,
 * so we deliberately keep this component small and declarative.
 */
export function E2EUnlockBanner() {
  const status = useE2ESession((s) => s.status);
  const unlockError = useE2ESession((s) => s.unlockError);
  const setUnlockError = useE2ESession((s) => s.setUnlockError);
  const [modalOpen, setModalOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Reset the dismissal whenever the state that produced the banner changes,
  // so a fresh failure after a successful unlock re-shows the recovery UI.
  const key = `${status}:${unlockError?.at ?? "none"}`;
  useMemo(() => {
    setDismissed(false);
  }, [key]);

  const visible = !dismissed && (status === "locked" || !!unlockError);
  if (!visible) return null;

  const isCorrupt = unlockError?.reason === "corrupt_material";
  const isNetwork = unlockError?.reason === "network";
  const title = unlockError?.title
    ?? (status === "locked" ? "Encryption is locked" : "Encryption isn't ready");
  const description = unlockError?.description
    ?? "Unlock your encrypted notes to send and read messages on this device.";

  return (
    <>
      <div
        role="alert"
        aria-live="polite"
        className="border-b border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100 px-3 sm:px-4 md:px-6 py-2.5"
      >
        <div className="flex items-start gap-3 flex-wrap">
          <div className="flex items-start gap-2 min-w-0 flex-1">
            {isCorrupt ? (
              <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" />
            ) : status === "locked" ? (
              <Lock className="w-4 h-4 mt-0.5 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            )}
            <div className="min-w-0">
              <div className="text-sm font-medium leading-tight">{title}</div>
              <div className="text-xs opacity-90 mt-0.5">{description}</div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-auto">
            {!isCorrupt && (
              <Button
                size="sm"
                variant="default"
                onClick={() => setModalOpen(true)}
                aria-label={isNetwork ? "Retry unlock" : "Unlock now"}
              >
                {isNetwork ? "Retry" : "Unlock now"}
              </Button>
            )}
            <Button size="sm" variant="outline" asChild>
              <Link to="/profile">
                {isCorrupt ? "Re-issue keypair" : "Manage keys"}
              </Link>
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              aria-label="Dismiss encryption warning"
              onClick={() => {
                setDismissed(true);
                // Clearing the persisted error prevents it from re-showing on
                // every route change while `status` stays "locked".
                if (unlockError) setUnlockError(null);
              }}
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>
      <E2EUnlockModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        onUnlocked={() => {
          setUnlockError(null);
        }}
      />
    </>
  );
}
