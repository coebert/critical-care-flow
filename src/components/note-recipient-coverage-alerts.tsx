import { ShieldAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { DirectoryEntry } from "@/hooks/use-recipient-directory";
import type { RecipientCoverage } from "@/hooks/use-recipient-coverage";

interface NoteRecipientCoverageAlertsProps {
  /** Only render alerts once the author's key is unlocked. */
  isUnlocked: boolean;
  /** Coverage snapshot from useRecipientCoverage. */
  coverage: RecipientCoverage;
  /**
   * True once the author has manually edited the recipient set — controls
   * whether the "partial coverage" alert should surface for missing-key-only
   * exclusions.
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
 * Renders the two recipient-coverage warnings that sit above the noteboard
 * compose box:
 *
 *  - a destructive alert when teammates haven't enrolled in E2E at all
 *  - an amber alert when the current recipient set only partially covers the
 *    team (someone deselected or missing a key)
 */
export function NoteRecipientCoverageAlerts({
  isUnlocked,
  coverage,
  recipientsTouched,
}: NoteRecipientCoverageAlertsProps) {
  if (!isUnlocked) return null;

  const {
    missingRecipients,
    eligibleRecipientCount,
    excludedMissingKey,
    excludedDeselected,
    partialCoverage,
  } = coverage;

  const showPartial = partialCoverage && (recipientsTouched || excludedDeselected.length > 0);

  return (
    <>
      {missingRecipients.length > 0 && (
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
            <ExcludedList people={missingRecipients} />
          </AlertDescription>
        </Alert>
      )}
      {showPartial && (
        <Alert className="mb-3 border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200 [&>svg]:text-amber-600">
          <ShieldAlert className="w-4 h-4" />
          <AlertTitle>
            Only {eligibleRecipientCount} of {eligibleRecipientCount + excludedMissingKey.length + excludedDeselected.length} teammates will be able to read this note
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
        </Alert>
      )}
    </>
  );
}
