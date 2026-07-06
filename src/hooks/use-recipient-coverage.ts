import { useMemo } from "react";

import type { DirectoryEntry } from "@/hooks/use-recipient-directory";

export interface RecipientCoverage {
  /** Teammates in the directory who haven't published an E2E key yet. */
  missingRecipients: DirectoryEntry[];
  /** How many selected recipients can actually decrypt. */
  eligibleRecipientCount: number;
  /** Teammates excluded because they have no published key. */
  excludedMissingKey: DirectoryEntry[];
  /** Teammates excluded because the author deselected them. */
  excludedDeselected: DirectoryEntry[];
  /** True when at least one teammate is excluded from an otherwise valid post. */
  partialCoverage: boolean;
}

/**
 * Derive coverage metrics for the noteboard compose recipient set.
 *
 * Keeps the "who can/can't read this note" bookkeeping out of the main
 * component so the alert UI can consume a single typed payload.
 */
export function useRecipientCoverage(
  directory: DirectoryEntry[],
  selectedRecipients: Set<string>,
  currentUserId: string | undefined,
): RecipientCoverage {
  return useMemo(() => {
    const missingRecipients = directory.filter(
      (r) => !r.public_key && r.user_id !== currentUserId,
    );
    const excludedMissingKey = missingRecipients;
    const excludedDeselected = directory.filter(
      (r) => r.user_id !== currentUserId && !!r.public_key && !selectedRecipients.has(r.user_id),
    );
    const eligibleRecipientCount = selectedRecipients.size;
    const partialCoverage =
      eligibleRecipientCount > 0 && excludedMissingKey.length + excludedDeselected.length > 0;
    return {
      missingRecipients,
      eligibleRecipientCount,
      excludedMissingKey,
      excludedDeselected,
      partialCoverage,
    };
  }, [directory, selectedRecipients, currentUserId]);
}
