import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import type { DirectoryEntry } from "@/hooks/use-recipient-directory";

interface ConfirmReducedRecipientsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  missingRecipients: DirectoryEntry[];
  eligibleRecipientCount: number;
  /** Called with the user's explicit opt-in. */
  onConfirm: () => void;
  /** Called when the user cancels (clears any queued action upstream). */
  onCancel: () => void;
}

/**
 * "You're about to post a note some teammates can never read" gate. Requires
 * an explicit acknowledgement checkbox before allowing the post to proceed.
 * Owns its own ack state so the parent doesn't need to reset it.
 */
export function ConfirmReducedRecipientsDialog({
  open,
  onOpenChange,
  missingRecipients,
  eligibleRecipientCount,
  onConfirm,
  onCancel,
}: ConfirmReducedRecipientsDialogProps) {
  const [ack, setAck] = useState(false);
  const n = missingRecipients.length;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => { onOpenChange(o); if (!o) setAck(false); }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-destructive" />
            Posting blocked — {n} teammate{n === 1 ? "" : "s"} can't read this note
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              <div>
                These teammates haven't enrolled in end-to-end encryption, so this note
                <strong> cannot be encrypted for them</strong> — even later, after they enroll.
              </div>
              <ul className="list-disc pl-5 text-xs max-h-32 overflow-auto">
                {missingRecipients.map((r) => (
                  <li key={r.user_id}>{r.full_name}</li>
                ))}
              </ul>
              <div>
                To continue, explicitly opt into posting to a reduced recipient set
                ({eligibleRecipientCount} enrolled teammate{eligibleRecipientCount === 1 ? "" : "s"}).
                Otherwise, cancel and ask them to enable encryption first.
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm cursor-pointer">
          <Checkbox
            checked={ack}
            onCheckedChange={(v) => setAck(v === true)}
            className="mt-0.5"
          />
          <span>
            I understand the excluded teammates will never be able to read this note,
            and I want to post it to the reduced recipient set anyway.
          </span>
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => { setAck(false); onCancel(); }}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={!ack}
            onClick={() => { if (ack) { setAck(false); onConfirm(); } }}
          >
            Post to reduced recipient set
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
