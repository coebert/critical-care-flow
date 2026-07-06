import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { NoteRecipientChipRow } from "@/components/note-recipient-chip-row";
import { NoteRecipientPicker } from "@/components/note-recipient-picker";
import type { DirectoryEntry } from "@/hooks/use-recipient-directory";

/** Hard cap for a single note body — matches the DB column limit. */
export const NOTE_BODY_MAX_LENGTH = 4000;
/** Show the character counter once the author is within this many chars of the cap. */
const COUNTER_WARN_WITHIN = 200;

export interface NoteValidationResult {
  ok: boolean;
  reason?: "empty" | "too-long";
}

/**
 * Pure client-side validation for a note body. Server-side checks in
 * `addEncryptedNote` / `updateNote` are still authoritative.
 */
export function validateNoteBody(
  body: string,
  maxLength = NOTE_BODY_MAX_LENGTH,
): NoteValidationResult {
  const trimmed = body.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (trimmed.length > maxLength) return { ok: false, reason: "too-long" };
  return { ok: true };
}

interface NoteComposerProps {
  /** Controlled body value. */
  value: string;
  /** Called on every keystroke. */
  onValueChange: (next: string) => void;
  /** Fires when the user submits. Errors/toasts are the parent's responsibility. */
  onSubmit: () => void | Promise<void>;
  /** Parent-owned in-flight flag; disables the button and shows a spinner. */
  posting: boolean;
  /** Author has an unlocked E2E key. Drives button label + recipient controls. */
  isUnlocked: boolean;
  /** How many recipients will actually receive the ciphertext. */
  eligibleRecipientCount: number;
  /** Optional override for the hard body length limit. */
  maxLength?: number;

  // Recipient UI
  directory: DirectoryEntry[];
  selectedRecipients: Set<string>;
  newlyEligibleIds: Set<string>;
  currentUserId?: string;
  onToggleRecipient: (userId: string) => void;
  onChangeRecipients: (next: Set<string>) => void;
}

/**
 * Reusable compose section for the noteboard: recipient chip strip, textarea,
 * validation counter, recipient picker, and primary send/save action. Presentational —
 * the parent owns text state, submit logic, and error toasts.
 */
export function NoteComposer({
  value,
  onValueChange,
  onSubmit,
  posting,
  isUnlocked,
  eligibleRecipientCount,
  maxLength = NOTE_BODY_MAX_LENGTH,
  directory,
  selectedRecipients,
  newlyEligibleIds,
  currentUserId,
  onToggleRecipient,
  onChangeRecipients,
}: NoteComposerProps) {
  const validation = validateNoteBody(value, maxLength);
  const trimmedLength = value.trim().length;
  const overLimit = validation.reason === "too-long";
  const showCounter = overLimit || trimmedLength >= maxLength - COUNTER_WARN_WITHIN;
  const canSubmit = validation.ok && !posting;

  const submitLabel = posting
    ? isUnlocked
      ? "Posting…"
      : "Unlocking…"
    : isUnlocked
      ? "Post encrypted note"
      : "Unlock & post";

  const helper = isUnlocked
    ? `Will be readable by ${eligibleRecipientCount} teammate${eligibleRecipientCount === 1 ? "" : "s"}.`
    : "Unlock end-to-end encryption to post an encrypted note.";

  return (
    <div className="space-y-2 mb-4">
      {isUnlocked && directory.length > 0 && (
        <NoteRecipientChipRow
          directory={directory}
          selected={selectedRecipients}
          newlyEligibleIds={newlyEligibleIds}
          currentUserId={currentUserId}
          onToggle={onToggleRecipient}
        />
      )}
      <Textarea
        rows={3}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        placeholder="e.g. seen in ED resus, awaiting bloods, for re-review at 6pm"
        aria-invalid={overLimit || undefined}
        aria-describedby="note-composer-helper"
      />
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span
          id="note-composer-helper"
          className={`text-[11px] ${overLimit ? "text-destructive" : "text-muted-foreground"}`}
        >
          {overLimit
            ? `Note is too long — trim ${trimmedLength - maxLength} character${
                trimmedLength - maxLength === 1 ? "" : "s"
              }.`
            : helper}
          {showCounter && !overLimit && (
            <span className="ml-2 tabular-nums opacity-70">
              {trimmedLength}/{maxLength}
            </span>
          )}
        </span>
        <div className="flex items-center gap-2">
          {isUnlocked && (
            <NoteRecipientPicker
              directory={directory}
              selected={selectedRecipients}
              onChange={onChangeRecipients}
              currentUserId={currentUserId}
              compact
            />
          )}
          <Button size="sm" onClick={() => void onSubmit()} disabled={!canSubmit}>
            {posting && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
