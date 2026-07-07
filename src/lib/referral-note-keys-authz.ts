/**
 * Pure mirror of the RLS policies on public.referral_note_keys.
 *
 * Keep this in lockstep with the SQL policies:
 *   - SELECT: recipient_user_id = auth.uid()
 *             OR note.author_id = auth.uid()
 *             OR has_role(auth.uid(), 'admin')
 *   - INSERT: note.author_id = auth.uid() OR admin
 *   - DELETE: note.author_id = auth.uid() OR admin
 *
 * There is no UPDATE policy — key rotation is a DELETE + INSERT pair.
 */
export type Op = "select" | "insert" | "delete";

export interface KeyRow {
  note_author_id: string;
  recipient_user_id: string;
}

export interface Caller {
  userId: string;
  isAdmin: boolean;
}

export function canAccessReferralNoteKey(
  op: Op,
  row: KeyRow,
  caller: Caller,
): boolean {
  const isAuthor = row.note_author_id === caller.userId;
  const isRecipient = row.recipient_user_id === caller.userId;
  if (op === "select") return isRecipient || isAuthor || caller.isAdmin;
  // INSERT / DELETE
  return isAuthor || caller.isAdmin;
}
