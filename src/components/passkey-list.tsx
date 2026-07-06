import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Fingerprint, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { listMyPasskeys, deleteMyPasskey } from "@/lib/webauthn.functions";
import { isPasskeySupported, registerPasskey, PASSKEY_BLOCKED_BY_FRAME } from "@/lib/passkeys";

type Passkey = {
  id: string;
  device_label: string | null;
  created_at: string;
  last_used_at: string | null;
  transports: string[];
};

export function PasskeyList() {
  const list = useServerFn(listMyPasskeys);
  const del = useServerFn(deleteMyPasskey);
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [loading, setLoading] = useState(true);
  const [addingKey, setAddingKey] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Passkey | null>(null);
  const [deleting, setDeleting] = useState(false);
  const supported = isPasskeySupported();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { passkeys } = await list();
      setPasskeys(passkeys as Passkey[]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load passkeys");
    } finally {
      setLoading(false);
    }
  }, [list]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addPasskey = async () => {
    setAddingKey(true);
    try {
      await registerPasskey();
      toast.success("Passkey added");
      await refresh();
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === PASSKEY_BLOCKED_BY_FRAME) {
        toast.error("Passkey setup blocked in preview", {
          description: err instanceof Error ? err.message : undefined,
          duration: 10000,
          action: typeof window !== "undefined"
            ? { label: "Open in new tab", onClick: () => window.open(window.location.href, "_blank", "noopener") }
            : undefined,
        });
      } else if (err instanceof Error && err.name === "NotAllowedError") {
        toast.message("Passkey setup cancelled");
      } else {
        toast.error(err instanceof Error ? err.message : "Could not add passkey");
      }
    } finally {
      setAddingKey(false);
    }
  };

  const doDelete = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await del({ data: { id: confirmDelete.id } });
      toast.success("Passkey removed");
      setConfirmDelete(null);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove passkey");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-2">
            <Fingerprint className="w-4 h-4" /> Passkeys
          </h2>
          <p className="text-xs text-muted-foreground mt-1 max-w-md">
            Sign in with Face ID, Touch ID, Windows Hello, or a hardware security key
            instead of your password. Add one passkey per device you trust.
          </p>
        </div>
        <Button
          size="sm"
          onClick={addPasskey}
          disabled={!supported || addingKey}
          title={supported ? undefined : "This browser doesn't support passkeys"}
        >
          {addingKey ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Adding…
            </>
          ) : (
            <>
              <Plus className="w-4 h-4 mr-2" /> Add passkey
            </>
          )}
        </Button>
      </div>

      {!supported && (
        <p className="text-xs text-muted-foreground">
          This browser does not support passkeys. Open the app on a device with
          Face ID, Touch ID, Windows Hello, or a hardware security key to add one.
        </p>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : passkeys.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No passkeys registered on this account yet.
        </p>
      ) : (
        <ul className="divide-y">
          {passkeys.map((pk) => (
            <li key={pk.id} className="py-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">
                  {pk.device_label ?? "Passkey"}
                </div>
                <div className="text-xs text-muted-foreground">
                  Added {formatDate(pk.created_at)}
                  {pk.last_used_at
                    ? ` · Last used ${formatDate(pk.last_used_at)}`
                    : " · Never used"}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove ${pk.device_label ?? "passkey"}`}
                onClick={() => setConfirmDelete(pk)}
              >
                <Trash2 className="w-4 h-4 text-destructive" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <AlertDialog
        open={!!confirmDelete}
        onOpenChange={(v) => { if (!v && !deleting) setConfirmDelete(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this passkey?</AlertDialogTitle>
            <AlertDialogDescription>
              You won't be able to sign in with this passkey any more. You can
              still sign in with your password, and add a new passkey later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void doDelete(); }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Removing…
                </>
              ) : (
                "Remove passkey"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function formatDate(iso: string): string {
  try {
    return format(new Date(iso), "dd/MM/yyyy HH:mm");
  } catch {
    return iso;
  }
}
