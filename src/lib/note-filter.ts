import type { Note } from "@/components/note-item";

export type NoteFilter = "all" | "e2e" | "legacy" | "failed";

const E2E_STATUSES = new Set([
  "e2e-decrypted",
  "e2e-locked",
  "e2e-no-key",
  "e2e-failed",
]);
const LEGACY_STATUSES = new Set(["legacy-server-enc", "plaintext"]);

/** Filter predicate matching the noteboard filter select values. */
export function matchesNoteFilter(note: Note, filter: NoteFilter): boolean {
  if (filter === "all") return true;
  if (filter === "e2e") return E2E_STATUSES.has(note._e2eStatus);
  if (filter === "legacy") return LEGACY_STATUSES.has(note._e2eStatus);
  if (filter === "failed") return note._e2eStatus === "e2e-failed";
  return true;
}

/** Counts per filter bucket — used to label the select options. */
export interface NoteFilterCounts {
  all: number;
  e2e: number;
  legacy: number;
  failed: number;
}

export function countNotesByFilter(notes: Note[]): NoteFilterCounts {
  return {
    all: notes.length,
    e2e: notes.filter((n) => E2E_STATUSES.has(n._e2eStatus)).length,
    legacy: notes.filter((n) => LEGACY_STATUSES.has(n._e2eStatus)).length,
    failed: notes.filter((n) => n._e2eStatus === "e2e-failed").length,
  };
}
