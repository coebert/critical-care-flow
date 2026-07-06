import { ShieldAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { DirectoryEntry } from "@/hooks/use-recipient-directory";

interface NoteMissingRecipientsAlertProps {
  /** Teammates without a published E2E key (excluding self). */
  missingRecipients: DirectoryEntry[];
}

/**
 * Destructive alert shown above the compose box when at least one teammate
 * hasn't enrolled in end-to-end encryption yet. Always visible while the
 * condition holds — this is a hard correctness warning, not a soft nudge, so
 * it intentionally has no dismiss control.
 */
export function NoteMissingRecipientsAlert({ missingRecipients }: NoteMissingRecipientsAlertProps) {
  if (missingRecipients.length === 0) return null;
  return (
    <Alert variant="destructive" className="mb-3">
      <ShieldAlert className="w-4 h-4" />
      <AlertTitle>
        {missingRecipients.length} teammate{missingRecipients.length === 1 ? "" : "s"} can't read encrypted notes yet
      </AlertTitle>
      <AlertDescription>
        <div className="mb-2">
          They haven't enabled end-to-end encryption on their account, so anything you post now will be
          <strong> undecryptable for them</strong> until they enroll and you re-post. Ask them to open the
          noteboard and choose <em>Enable encryption</em>.
        </div>
        <ul className="list-disc pl-5 text-xs max-h-24 overflow-auto">
          {missingRecipients.slice(0, 8).map((r) => (
            <li key={r.user_id}>{r.full_name}</li>
          ))}
          {missingRecipients.length > 8 && <li>and {missingRecipients.length - 8} more…</li>}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
