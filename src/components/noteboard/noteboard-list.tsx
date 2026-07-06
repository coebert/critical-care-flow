import { NoteItem, type Note } from "@/components/note-item";
import type { DirectoryEntry } from "@/hooks/use-recipient-directory";

interface NoteboardListProps {
  notes: Note[];
  authors: Record<string, string>;
  directory: DirectoryEntry[];
  currentUserId: string | undefined;
  isAdmin: boolean;
  totalNotes: number;
  onSave: (note: Note, body: string, recipients?: Set<string>) => Promise<void>;
  onDelete: (note: Note) => Promise<void>;
}

const NON_EDITABLE_STATUSES: Array<Note["_e2eStatus"]> = [
  "e2e-locked",
  "e2e-no-key",
  "e2e-failed",
  "legacy-server-enc",
  "plaintext",
];

/**
 * Scrollable list of decrypted notes. Handles the two empty-state messages
 * (no notes at all vs. no notes match the active filter) and wires each row
 * up to the parent's save/delete handlers.
 */
export function NoteboardList({
  notes,
  authors,
  directory,
  currentUserId,
  isAdmin,
  totalNotes,
  onSave,
  onDelete,
}: NoteboardListProps) {
  return (
    <div className="space-y-3 max-h-[520px] overflow-auto">
      {notes.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {totalNotes === 0 ? "No notes yet." : "No notes match the selected filter."}
        </p>
      )}
      {notes.map((n) => {
        const canEdit =
          !!currentUserId &&
          (currentUserId === n.author_id || isAdmin) &&
          !NON_EDITABLE_STATUSES.includes(n._e2eStatus);
        return (
          <NoteItem
            key={n.id}
            note={n}
            authorName={authors[n.author_id] ?? "Clinician"}
            authorMap={authors}
            directory={directory}
            currentUserId={currentUserId}
            canEdit={canEdit}
            onSave={(body, recipients) => onSave(n, body, recipients)}
            onDelete={() => onDelete(n)}
          />
        );
      })}
    </div>
  );
}
