import { useEffect, useMemo, useState } from "react";
import { ShieldAlert, X } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { DirectoryEntry } from "@/hooks/use-recipient-directory";
import type { RecipientCoverage } from "@/hooks/use-recipient-coverage";

interface NotePartialCoverageAlertProps {
  /** Coverage snapshot from useRecipientCoverage. */
  coverage: RecipientCoverage;
  /**
   * True once the author has manually edited the recipient set. When false,
   * we only surface the alert if someone was explicitly deselected — a
   * missing-key-only exclusion is already covered by the destructive alert.
   */
  recipientsTouched: boolean;
}

function ExcludedList({ people }: { people: DirectoryEntry[] }) {
  return (
    <ul className="list-disc pl-5 text-xs max-h-24 overflow-auto">
      {people.slice(0, 8).map((r) => (
        <li key={r.user_id}>{r.full_name}</li>
      ))}
      {people.length > 8 && <li>and {people.length - 8} more…</li>}
    </ul>
  );
}

/**
 * Amber warning that summarises which teammates *won't* be able to decrypt
 * the note the author is composing. Dismissible — the dismissal is keyed on
 * the current excluded set, so if the excluded roster changes (someone new
 * gets deselected, or a teammate enrolls) the alert reappears automatically.
 */
export function NotePartialCoverageAlert({
  coverage,
  recipientsTouched,
}: NotePartialCoverageAlertProps) {
  const { eligibleRecipientCount, excludedMissingKey, excludedDeselected, partialCoverage } = coverage;

  // Stable identity for the current excluded set — dismissal is scoped to it.
  const exclusionKey = useMemo(() => {
    const ids = [
      ...excludedDeselected.map((r) => `d:${r.user_id}`),
      ...excludedMissingKey.map((r) => `m:${r.user_id}`),
    ];
    ids.sort();
    return ids.join("|");
  }, [excludedDeselected, excludedMissingKey]);

  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  useEffect(() => {
    // Reset dismissal whenever the excluded set changes.
    if (dismissedKey && dismissedKey !== exclusionKey) setDismissedKey(null);
  }, [exclusionKey, dismissedKey]);

  const shouldShow = partialCoverage && (recipientsTouched || excludedDeselected.length > 0);
  if (!shouldShow) return null;
  if (dismissedKey === exclusionKey) return null;

  const total = eligibleRecipientCount + excludedMissingKey.length + excludedDeselected.length;

  return (
    <Alert className="mb-3 border-warning/40 bg-warning/10 text-warning-text [&>svg]:text-warning relative pr-10">
      <ShieldAlert className="w-4 h-4" aria-hidden="true" />
      <AlertTitle>
        Only {eligibleRecipientCount} of {total} teammates will be able to read this note
      </AlertTitle>
      <AlertDescription>
        <div className="mb-2 text-xs">
          The people below <strong>will not</strong> be able to decrypt this note as composed.
          Adjust recipients or ask them to enable encryption before posting.
        </div>
        {excludedDeselected.length > 0 && (
          <div className="mb-2">
            <div className="text-[11px] font-medium uppercase tracking-wide opacity-80">
              Deselected ({excludedDeselected.length})
            </div>
            <ExcludedList people={excludedDeselected} />
          </div>
        )}
        {excludedMissingKey.length > 0 && (
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide opacity-80">
              No encryption key yet ({excludedMissingKey.length})
            </div>
            <ExcludedList people={excludedMissingKey} />
          </div>
        )}
      </AlertDescription>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label="Dismiss coverage warning"
        className="absolute top-1 right-1 h-8 w-8 text-warning-text/80 hover:text-warning-text hover:bg-warning/15"
        onClick={() => setDismissedKey(exclusionKey)}
      >
        <X className="w-4 h-4" aria-hidden="true" />
      </Button>
    </Alert>
  );
}
