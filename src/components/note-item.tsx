import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { History, Lock, Pencil, Save, ShieldAlert, ShieldCheck, ShieldOff, Trash2, Users, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { NoteRecipientPicker } from "@/components/note-recipient-picker";

import { tzTooltip } from "@/lib/format-timestamp";
import { friendlyE2EError } from "@/lib/friendly-e2e-error";
import { getNoteHistory, type DecryptedReferralNote } from "@/lib/referrals.functions";
import type { Tables } from "@/integrations/supabase/types";

/**
 * Shape rendered by the noteboard: a row from `referral_notes` merged with
 * the decrypted body and per-render metadata (recipient list, current E2E
 * status). Exported so the parent route can type its notes array without
 * duplicating the definition.
 */
export type Note = Tables<"referral_notes"> & DecryptedReferralNote & {
  wrapped_key?: string | null;
  body_ciphertext?: string | null;
  body_nonce?: string | null;
  enc_version?: number | null;
  recipient_user_ids?: string[];
  _e2eStatus?: "plaintext" | "legacy-server-enc" | "e2e-decrypted" | "e2e-locked" | "e2e-no-key" | "e2e-failed";
};

/**
 * Single noteboard entry. Owns its own edit/delete UI state; the parent
 * route provides the persistence callbacks (`onSave`, `onDelete`) so this
 * component is agnostic to the E2E encryption plumbing.
 */
export function NoteItem({
  note,
  authorName,
  authorMap,
  directory,
  currentUserId,
  canEdit,
  canViewAudit = false,
  onSave,
  onDelete,
}: {
  note: Note;
  authorName: string;
  authorMap: Record<string, string>;
  directory: Array<{ user_id: string; full_name: string; public_key: string | null }>;
  currentUserId?: string;
  canEdit: boolean;
  /** Show the note-history/audit button. Admin-only surface. */
  canViewAudit?: boolean;
  onSave: (body: string, recipients?: Set<string>) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body ?? "");
  const [busy, setBusy] = useState(false);
  const [editRecipients, setEditRecipients] = useState<Set<string>>(
    () => new Set(note.recipient_user_ids ?? []),
  );
  const edited = (note as any).edited_at as string | null | undefined;
  const isE2E = !!note.body_ciphertext;
  const recipientList = note.recipient_user_ids ?? [];

  const beginEdit = () => {
    setDraft(note.body ?? "");
    setEditRecipients(new Set(note.recipient_user_ids ?? []));
    setEditing(true);
  };

  const save = async () => {
    if (!draft.trim()) { setEditing(false); return; }
    const bodyUnchanged = draft.trim() === note.body;
    const currentSet = new Set(note.recipient_user_ids ?? []);
    const recipientsUnchanged =
      currentSet.size === editRecipients.size &&
      [...currentSet].every((id) => editRecipients.has(id));
    if (bodyUnchanged && recipientsUnchanged) { setEditing(false); return; }
    setBusy(true);
    try { await onSave(draft.trim(), isE2E ? editRecipients : undefined); setEditing(false); }
    catch (e: any) {
      const f = friendlyE2EError(e, "edit-note");
      toast.error(f.title, { description: f.description, duration: 8000 });
    }
    finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true);
    try { await onDelete(); }
    catch (e: any) {
      const f = friendlyE2EError(e, "edit-note");
      toast.error(f.title, { description: f.description, duration: 8000 });
      setBusy(false);
    }
  };

  return (
    <div className="text-sm border-l-2 border-primary/40 pl-3 py-1 group">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <span className="text-xs font-medium flex items-center gap-2">
          {authorName}
          <E2EBadge status={note._e2eStatus} />
        </span>
        <span className="text-[11px] text-muted-foreground" title={tzTooltip(note.created_at)}>
          {format(new Date(note.created_at), "dd/MM/yyyy HH:mm")} · {formatDistanceToNow(new Date(note.created_at), { addSuffix: true })}
          {edited && (
            <span className="ml-1 italic" title={`Edited\n${tzTooltip(edited)}`}>(edited)</span>
          )}
        </span>
      </div>
      {editing ? (
        <div className="space-y-2">
          <Textarea rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={busy} />
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-[11px] text-muted-foreground">
              {isE2E
                ? `${editRecipients.size} recipient${editRecipients.size === 1 ? "" : "s"} — re-encrypted on save.`
                : "Legacy note — recipients not applicable."}
            </span>
            <div className="flex justify-end gap-2">
              {isE2E && (
                <NoteRecipientPicker
                  directory={directory}
                  selected={editRecipients}
                  onChange={setEditRecipients}
                  currentUserId={currentUserId}
                  compact
                />
              )}
              <Button size="sm" variant="ghost" onClick={() => { setDraft(note.body ?? ""); setEditing(false); }} disabled={busy}>
                <X className="w-3.5 h-3.5 mr-1" /> Cancel
              </Button>
              <Button size="sm" onClick={save} disabled={busy || !draft.trim() || (isE2E && editRecipients.size === 0)}>
                <Save className="w-3.5 h-3.5 mr-1" /> {busy ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </div>
      ) : note._e2eStatus === "e2e-locked" ? (
        <div className="text-xs italic text-muted-foreground flex items-center gap-1"><Lock className="w-3 h-3" /> Encrypted — unlock the noteboard to read.</div>
      ) : note._e2eStatus === "e2e-no-key" ? (
        <div className="text-xs italic text-muted-foreground flex items-center gap-1"><ShieldAlert className="w-3 h-3" /> Encrypted — you were not a recipient of this note.</div>
      ) : note._e2eStatus === "e2e-failed" ? (
        <div className="text-xs italic text-destructive flex items-center gap-1"><ShieldAlert className="w-3 h-3" /> Could not decrypt this note.</div>
      ) : note._e2eStatus === "legacy-server-enc" || note._e2eStatus === "plaintext" ? (
        <>
          <div className="whitespace-pre-wrap">{note.body}</div>
          <div className="mt-1 text-[10px] italic text-muted-foreground">Legacy note — not end-to-end encrypted.</div>
        </>
      ) : (
        <div className="whitespace-pre-wrap">{note.body}</div>
      )}
      {isE2E && !editing && (
        <NoteAudienceInfo
          recipientIds={recipientList}
          directory={directory}
          authorId={note.author_id}
          currentUserId={currentUserId}
          authorMap={authorMap}
        />
      )}


      <div className="mt-1 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {canViewAudit && <NoteHistoryButton noteId={note.id} />}
        {canEdit && !editing && (
          <>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={beginEdit} disabled={busy}>
              <Pencil className="w-3.5 h-3.5 mr-1" /> Edit
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive hover:text-destructive" disabled={busy}>
                  <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this note?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The note will be removed for everyone. The deletion is recorded in the audit trail.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={remove} disabled={busy} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                    {busy ? "Deleting…" : "Delete note"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
      </div>
    </div>
  );
}

function E2EBadge({ status }: { status?: Note["_e2eStatus"] }) {
  const map: Record<NonNullable<Note["_e2eStatus"]>, { label: string; title: string; className: string; Icon: typeof ShieldCheck }> = {
    "e2e-decrypted":     { label: "E2E encrypted", title: "End-to-end encrypted. Decrypted in your browser with your private key.", className: "bg-success/10 text-success-text border-success/40", Icon: ShieldCheck },
    "e2e-locked":        { label: "E2E encrypted", title: "End-to-end encrypted. Unlock the noteboard to decrypt.", className: "bg-success/10 text-success-text border-success/40", Icon: Lock },
    "e2e-no-key":        { label: "E2E encrypted", title: "End-to-end encrypted, but you were not a recipient of this note.", className: "bg-warning/10 text-warning-text border-warning/40", Icon: ShieldAlert },
    "e2e-failed":        { label: "Decrypt failed", title: "End-to-end encrypted, but decryption failed.", className: "bg-destructive/10 text-destructive border-destructive/30", Icon: ShieldAlert },
    "legacy-server-enc": { label: "Not E2E encrypted", title: "Legacy note — stored server-side, not end-to-end encrypted.", className: "bg-muted text-muted-foreground border-border", Icon: ShieldOff },
    "plaintext":         { label: "Not E2E encrypted", title: "Legacy plaintext note — not end-to-end encrypted.", className: "bg-muted text-muted-foreground border-border", Icon: ShieldOff },
  };
  const entry = status ? map[status] : undefined;
  if (!entry) return null;
  const { label, title, className, Icon } = entry;
  return (
    <span title={title} className={`inline-flex items-center gap-1 text-[10px] leading-none px-1.5 py-0.5 rounded border ${className}`}>
      <Icon className="w-3 h-3" /> {label}
    </span>
  );
}

function NoteAudienceInfo({
  recipientIds,
  directory,
  authorId,
  currentUserId,
  authorMap,
}: {
  recipientIds: string[];
  directory: Array<{ user_id: string; full_name: string; public_key: string | null }>;
  authorId: string;
  currentUserId?: string;
  authorMap: Record<string, string>;
}) {
  const recipientSet = new Set(recipientIds);
  const nameFor = (uid: string) =>
    directory.find((r) => r.user_id === uid)?.full_name ?? authorMap[uid] ?? "Clinician";

  const canDecrypt = recipientIds.map((uid) => ({ user_id: uid, full_name: nameFor(uid) }));
  // Everyone in the directory who wasn't a recipient of this note.
  const excluded = directory.filter((r) => !recipientSet.has(r.user_id) && r.user_id !== authorId);
  const excludedMissingKey = excluded.filter((r) => !r.public_key);
  const excludedWithKey = excluded.filter((r) => !!r.public_key);
  const youAreExcluded =
    !!currentUserId && currentUserId !== authorId && !recipientSet.has(currentUserId);

  return (
    <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
          >
            <Users className="w-3 h-3" />
            {canDecrypt.length} can read
            {excluded.length > 0 && ` · ${excluded.length} cannot`}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0" align="start">
          <div className="p-3 border-b">
            <div className="text-sm font-medium">Who can read this note</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              Based on the recipient set at post time and the current key directory.
            </div>
          </div>
          <div className="max-h-72 overflow-auto p-3 space-y-3 text-xs">
            <section>
              <div className="flex items-center gap-1 font-medium text-success-text mb-1">
                <ShieldCheck className="w-3.5 h-3.5" /> Can decrypt ({canDecrypt.length})
              </div>
              {canDecrypt.length === 0 ? (
                <div className="text-muted-foreground italic">No recipients recorded.</div>
              ) : (
                <ul className="space-y-0.5 pl-4 list-disc">
                  {canDecrypt.map((r) => (
                    <li key={r.user_id}>
                      {r.full_name}
                      {r.user_id === currentUserId && <span className="text-muted-foreground"> (you)</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {excludedMissingKey.length > 0 && (
              <section>
                <div className="flex items-center gap-1 font-medium text-destructive mb-1">
                  <ShieldAlert className="w-3.5 h-3.5" /> Cannot decrypt — no public key
                  ({excludedMissingKey.length})
                </div>
                <ul className="space-y-0.5 pl-4 list-disc">
                  {excludedMissingKey.map((r) => (
                    <li key={r.user_id} className="flex items-center justify-between gap-2">
                      <span>{r.full_name}</span>
                      <span className="text-[10px] text-muted-foreground">no key</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 text-muted-foreground">
                  Ask them to open the noteboard on any referral and choose{" "}
                  <span className="italic">Enable encryption</span>. Once they publish a
                  key, edit and re-save this note to include them.
                </div>
              </section>
            )}

            {excludedWithKey.length > 0 && (
              <section>
                <div className="flex items-center gap-1 font-medium text-warning-text mb-1">
                  <ShieldOff className="w-3.5 h-3.5" /> Not selected as a recipient
                  ({excludedWithKey.length})
                </div>
                <ul className="space-y-0.5 pl-4 list-disc">
                  {excludedWithKey.map((r) => (
                    <li key={r.user_id}>{r.full_name}</li>
                  ))}
                </ul>
                <div className="mt-2 text-muted-foreground">
                  These teammates are enrolled but weren't chosen at post time.
                  Edit the note to add them.
                </div>
              </section>
            )}
          </div>
        </PopoverContent>
      </Popover>
      {youAreExcluded && (
        <span className="text-destructive/80">You are not a recipient.</span>
      )}
    </div>
  );
}

function NoteHistoryButton({ noteId }: { noteId: string }) {
  const fetchHistory = useServerFn(getNoteHistory);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [entries, setEntries] = useState<Array<{
    id: string; action: string; created_at: string; user_id: string; user_name: string; diff: any;
  }>>([]);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetchHistory({ data: { note_id: noteId } });
      setEntries(res as any);
    } catch (e: any) {
      toast.error(e.message ?? "Failed to load history");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (v) load(); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs">
          <History className="w-3.5 h-3.5 mr-1" /> History
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Note audit trail</DialogTitle>
        </DialogHeader>
        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!loading && entries.length === 0 && (
          <p className="text-sm text-muted-foreground">No audit entries found.</p>
        )}
        <div className="space-y-3 max-h-[60vh] overflow-auto">
          {entries.map((e) => (
            <div key={e.id} className="text-sm border-l-2 border-muted pl-3">
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <span className="text-xs font-medium capitalize">{e.action} · {e.user_name}</span>
                <span className="text-[11px] text-muted-foreground" title={tzTooltip(e.created_at)}>
                  {format(new Date(e.created_at), "dd/MM/yyyy HH:mm:ss")}
                </span>
              </div>
              {e.action === "update" && e.diff?.before?.body !== undefined && (
                <div className="space-y-1 text-xs">
                  <div className="text-muted-foreground">Before:</div>
                  <div className="whitespace-pre-wrap bg-muted/50 rounded px-2 py-1">{e.diff.before.body}</div>
                  <div className="text-muted-foreground">After:</div>
                  <div className="whitespace-pre-wrap bg-muted/50 rounded px-2 py-1">{e.diff.after?.body}</div>
                </div>
              )}
              {e.action === "create" && e.diff?.body && (
                <div className="text-xs whitespace-pre-wrap bg-muted/50 rounded px-2 py-1">{e.diff.body}</div>
              )}
              {e.action === "delete" && e.diff?.body && (
                <div className="text-xs whitespace-pre-wrap bg-muted/50 rounded px-2 py-1 line-through opacity-70">{e.diff.body}</div>
              )}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
