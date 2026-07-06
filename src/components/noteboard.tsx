import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, LockOpen } from "lucide-react";
import { toast } from "sonner";


import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import { NoteItem } from "@/components/note-item";
import { NoteRecipientPicker } from "@/components/note-recipient-picker";
import { NoteRecipientChipRow } from "@/components/note-recipient-chip-row";
import { ConfirmReducedRecipientsDialog } from "@/components/confirm-reduced-recipients-dialog";
import { NoteRecipientCoverageAlerts } from "@/components/note-recipient-coverage-alerts";
import { E2EUnlockModal } from "@/components/e2e-unlock-modal";

import { supabase } from "@/integrations/supabase/client";
import { addEncryptedNote, listEncryptedNotes, updateEncryptedNote } from "@/lib/encrypted-notes.functions";
import { deleteNote, updateNote } from "@/lib/referrals.functions";
import { getMyPrivateKeyMaterial, getPublicKeyDirectory } from "@/lib/e2e-keys.functions";
import { encryptNote as e2eEncryptNote } from "@/lib/e2e-crypto";
import { useE2ESession } from "@/hooks/use-e2e-session";
import { useAuth, useRole } from "@/hooks/use-auth";
import { useDecryptedNotes } from "@/hooks/use-decrypted-notes";
import { useRecipientDirectory, type DirectoryEntry } from "@/hooks/use-recipient-directory";
import { useRecipientCoverage } from "@/hooks/use-recipient-coverage";
import { friendlyE2EError } from "@/lib/friendly-e2e-error";

// Raw ciphertext rows for a referral's notes. Exported so the route loader
// can prime the cache before mount.
export const referralNotesQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ["referrals", "detail", id, "notes"] as const,
    queryFn: () => listEncryptedNotes({ data: { referral_id: id } }),
    staleTime: 5_000,
  });

interface NoteboardProps {
  referralId: string;
}

/**
 * End-to-end encrypted noteboard for a referral. Owns:
 *  - the raw notes query + decrypt-into-`notes` pipeline (useDecryptedNotes)
 *  - the recipient directory + realtime + newly-eligible highlight
 *    (useRecipientDirectory)
 *  - the E2E session bootstrap, unlock modal, and queued-action retry
 *  - the compose textarea, chip picker, and reduced-set opt-in dialog
 *
 * The parent route only supplies the `referralId`.
 */
export function Noteboard({ referralId: id }: NoteboardProps) {
  const { user } = useAuth();
  const { hasRole: isAdmin } = useRole("admin");
  const queryClient = useQueryClient();

  const updateNoteFn = useServerFn(updateNote);
  const deleteNoteFn = useServerFn(deleteNote);
  const fetchKeyMaterial = useServerFn(getMyPrivateKeyMaterial);
  const fetchKeyDir = useServerFn(getPublicKeyDirectory);
  const submitEncNote = useServerFn(addEncryptedNote);
  const editEncNote = useServerFn(updateEncryptedNote);

  const e2e = useE2ESession();

  const { data: rawNotes } = useQuery(referralNotesQueryOptions(id));
  const { notes, authors } = useDecryptedNotes(rawNotes, e2e);

  const { directory, newlyEligibleIds, reload: loadDirectory } = useRecipientDirectory({
    currentUserId: user?.id,
    isUnlocked: e2e.isUnlocked,
    fetchKeyDir,
  });

  const [noteBody, setNoteBody] = useState("");
  const [posting, setPosting] = useState(false);
  const [noteFilter, setNoteFilter] = useState<"all" | "e2e" | "legacy" | "failed">("all");
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [confirmMissingOpen, setConfirmMissingOpen] = useState(false);
  const pendingActionRef = useRef<null | (() => Promise<void>)>(null);
  const [selectedRecipients, setSelectedRecipients] = useState<Set<string>>(new Set());
  const [recipientsTouched, setRecipientsTouched] = useState(false);

  const refetchNotes = () =>
    queryClient.invalidateQueries({ queryKey: referralNotesQueryOptions(id).queryKey });

  // Realtime for this referral's notes — the directory has its own subscription.
  useEffect(() => {
    const ch = supabase
      .channel(`ref-notes-${id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "referral_notes", filter: `referral_id=eq.${id}` },
        () => { refetchNotes(); })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Default the recipient selection to every enrolled teammate (plus self)
  // until the author manually changes it.
  useEffect(() => {
    if (recipientsTouched) return;
    const ids = new Set<string>(directory.filter((r) => !!r.public_key).map((r) => r.user_id));
    if (user?.id && e2e.publicKey) ids.add(user.id);
    setSelectedRecipients(ids);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directory, user?.id, e2e.publicKey]);

  // Bootstrap E2E session: rehydrate a persisted unlock (sessionStorage)
  // before falling back to fetching the stored key material.
  useEffect(() => {
    if (!user) return;
    if (e2e.material || e2e.needsBootstrap) return;
    (async () => {
      if (!e2e.hydrated) await e2e.hydrateFromSession();
      try {
        const res: any = await fetchKeyMaterial();
        e2e.setMaterial(res?.material ?? null, res?.public_key ?? null);
      } catch { /* non-fatal */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const directoryWithSelf: DirectoryEntry[] = (() => {
    if (!user?.id || !e2e.publicKey) return directory;
    if (directory.some((r) => r.user_id === user.id)) return directory;
    return [...directory, { user_id: user.id, full_name: "You", public_key: e2e.publicKey }];
  })();

  const coverage = useRecipientCoverage(directory, selectedRecipients, user?.id);
  const { missingRecipients, eligibleRecipientCount } = coverage;

  const encryptForRecipients = async (body: string, recipientIds: Set<string>) => {
    const dir = await fetchKeyDir();
    const byId = new Map<string, string>();
    for (const r of (dir ?? []) as any[]) {
      if (r.public_key) byId.set(r.user_id, r.public_key as string);
    }
    if (e2e.publicKey && user && !byId.has(user.id)) byId.set(user.id, e2e.publicKey);
    const recipients = Array.from(recipientIds)
      .filter((rid) => byId.has(rid))
      .map((rid) => ({ user_id: rid, public_key: byId.get(rid)! }));
    if (!recipients.length) throw new Error("Pick at least one enrolled recipient before posting.");
    return e2eEncryptNote(body, recipients);
  };

  /**
   * Gate for referral encryption actions. If the recipient key isn't Ready
   * (unlocked in this tab), queue the action, prompt the user to unlock/enable
   * encryption, and return false. The queued action re-runs automatically
   * after a successful unlock via the E2EUnlockModal's onUnlocked callback,
   * so the user doesn't have to click Post/Save a second time.
   */
  const ensureUnlocked = (action: () => Promise<void>): boolean => {
    if (e2e.isUnlocked) return true;
    pendingActionRef.current = action;
    setUnlockOpen(true);
    toast.info(
      e2e.needsBootstrap
        ? "Enable end-to-end encryption to post this note."
        : "Unlock your recipient key to continue — we'll finish this action for you.",
    );
    return false;
  };

  const doPostNote = async () => {
    setPosting(true);
    try {
      const enc = await encryptForRecipients(noteBody.trim(), selectedRecipients);
      await submitEncNote({
        data: {
          referral_id: id,
          ...enc,
          allow_reduced_recipients: recipientsTouched,
        },
      });
      setNoteBody("");
      await refetchNotes();
    } catch (err: any) {
      const msg = String(err?.message ?? "");
      const marker = "RECIPIENT_COVERAGE_CHANGED::";
      const idx = msg.indexOf(marker);
      if (idx >= 0) {
        let payload: {
          missing_no_key: Array<{ user_id: string; full_name: string }>;
          enrolled_but_excluded: Array<{ user_id: string; full_name: string }>;
          stray_recipients: Array<{ user_id: string; full_name: string }>;
        } | null = null;
        try {
          payload = JSON.parse(msg.slice(idx + marker.length));
        } catch { /* fall through to generic toast */ }
        await loadDirectory();
        if (payload) {
          const fmt = (people: Array<{ full_name: string }>) =>
            people.length <= 3
              ? people.map((p) => p.full_name).join(", ")
              : `${people.slice(0, 3).map((p) => p.full_name).join(", ")} and ${people.length - 3} more`;
          const lines: string[] = [];
          if (payload.missing_no_key.length > 0) {
            lines.push(`Lost/never-published keys: ${fmt(payload.missing_no_key)}`);
          }
          if (payload.enrolled_but_excluded.length > 0) {
            lines.push(`Enrolled but not in recipients: ${fmt(payload.enrolled_but_excluded)}`);
          }
          if (payload.stray_recipients.length > 0) {
            lines.push(`Recipients with no current key: ${fmt(payload.stray_recipients)}`);
          }
          toast.error("Recipient list changed since you started composing", {
            description: lines.join(" · "),
            duration: 12000,
            action: {
              label: "Refresh recipients",
              onClick: () => { loadDirectory(); },
            },
          });
        } else {
          toast.error(
            "Recipient list changed since you started composing. Review recipients and try again.",
            { duration: 6000 },
          );
        }
      } else {
        const friendly = friendlyE2EError(err, "post-note");
        toast.error(friendly.title, { description: friendly.description, duration: 8000 });
      }
    } finally {
      setPosting(false);
    }
  };

  const postNote = async () => {
    if (!noteBody.trim()) return;
    if (!ensureUnlocked(postNote)) return;
    if (selectedRecipients.size === 0) {
      toast.error("Pick at least one recipient for this note.");
      return;
    }
    const list = await loadDirectory();
    const missing = (list ?? directory).filter(
      (r) => !r.public_key && r.user_id !== user?.id,
    );
    if (missing.length > 0 && !recipientsTouched) {
      pendingActionRef.current = doPostNote;
      setConfirmMissingOpen(true);
      return;
    }
    await doPostNote();
  };

  const filteredNotes = notes.filter((n) => {
    if (noteFilter === "all") return true;
    if (noteFilter === "e2e") return n._e2eStatus === "e2e-decrypted" || n._e2eStatus === "e2e-locked" || n._e2eStatus === "e2e-no-key" || n._e2eStatus === "e2e-failed";
    if (noteFilter === "legacy") return n._e2eStatus === "legacy-server-enc" || n._e2eStatus === "plaintext";
    if (noteFilter === "failed") return n._e2eStatus === "e2e-failed";
    return true;
  });

  const toggleRecipient = (userId: string) => {
    setRecipientsTouched(true);
    setSelectedRecipients((cur) => {
      const next = new Set(cur);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  return (
    <>
      <Card className="p-5">
        <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="font-semibold flex items-center gap-2">
              Noteboard
              {e2e.isUnlocked ? (
                <Badge variant="outline" className="text-[10px] gap-1">
                  <LockOpen className="w-3 h-3" /> E2E unlocked
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px] gap-1">
                  <Lock className="w-3 h-3" /> E2E locked
                </Badge>
              )}
            </h2>
            <Select value={noteFilter} onValueChange={(v) => setNoteFilter(v as typeof noteFilter)}>
              <SelectTrigger className="h-7 text-xs w-auto min-w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All notes ({notes.length})</SelectItem>
                <SelectItem value="e2e">E2E encrypted ({notes.filter((n) => n._e2eStatus === "e2e-decrypted" || n._e2eStatus === "e2e-locked" || n._e2eStatus === "e2e-no-key" || n._e2eStatus === "e2e-failed").length})</SelectItem>
                <SelectItem value="legacy">Legacy plaintext ({notes.filter((n) => n._e2eStatus === "legacy-server-enc" || n._e2eStatus === "plaintext").length})</SelectItem>
                <SelectItem value="failed">Failed to decrypt ({notes.filter((n) => n._e2eStatus === "e2e-failed").length})</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {!e2e.isUnlocked && (
            <Button size="sm" variant="outline" onClick={() => setUnlockOpen(true)}>
              {e2e.needsBootstrap ? "Enable encryption" : "Unlock notes"}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Messages are end-to-end encrypted in your browser — the server only stores ciphertext.
        </p>
        <NoteRecipientCoverageAlerts
          isUnlocked={e2e.isUnlocked}
          coverage={coverage}
          recipientsTouched={recipientsTouched}
        />
        <div className="space-y-2 mb-4">
          {e2e.isUnlocked && directoryWithSelf.length > 0 && (
            <NoteRecipientChipRow
              directory={directoryWithSelf}
              selected={selectedRecipients}
              newlyEligibleIds={newlyEligibleIds}
              currentUserId={user?.id}
              onToggle={toggleRecipient}
            />
          )}
          <Textarea rows={3} value={noteBody} onChange={(e) => setNoteBody(e.target.value)} placeholder="e.g. seen in ED resus, awaiting bloods, for re-review at 6pm" />
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-[11px] text-muted-foreground">
              {e2e.isUnlocked
                ? `Will be readable by ${eligibleRecipientCount} teammate${eligibleRecipientCount === 1 ? "" : "s"}.`
                : ""}
            </span>
            <div className="flex items-center gap-2">
              {e2e.isUnlocked && (
                <NoteRecipientPicker
                  directory={directoryWithSelf}
                  selected={selectedRecipients}
                  onChange={(next) => { setRecipientsTouched(true); setSelectedRecipients(next); }}
                  currentUserId={user?.id}
                  compact
                />
              )}
              <Button size="sm" onClick={postNote} disabled={posting || !noteBody.trim()}>
                {posting ? "Posting…" : e2e.isUnlocked ? "Post encrypted note" : "Unlock & post"}
              </Button>
            </div>
          </div>
        </div>
        <div className="space-y-3 max-h-[520px] overflow-auto">
          {filteredNotes.length === 0 && (
            <p className="text-xs text-muted-foreground">
              {notes.length === 0 ? "No notes yet." : "No notes match the selected filter."}
            </p>
          )}
          {filteredNotes.map((n) => (
            <NoteItem
              key={n.id}
              note={n}
              authorName={authors[n.author_id] ?? "Clinician"}
              authorMap={authors}
              directory={directoryWithSelf}
              currentUserId={user?.id}
              canEdit={!!user && (user.id === n.author_id || isAdmin) && n._e2eStatus !== "e2e-locked" && n._e2eStatus !== "e2e-no-key" && n._e2eStatus !== "e2e-failed" && n._e2eStatus !== "legacy-server-enc" && n._e2eStatus !== "plaintext"}
              onSave={async (body, recipients) => {
                if (n.body_ciphertext) {
                  const retry = () => (async () => {
                    const enc2 = await encryptForRecipients(body, recipients ?? new Set());
                    await editEncNote({ data: { id: n.id, ...enc2 } });
                    await refetchNotes();
                    toast.success("Note updated");
                  })();
                  if (!ensureUnlocked(() => retry())) return;
                  if (!recipients || recipients.size === 0) {
                    toast.error("Pick at least one recipient before saving.");
                    return;
                  }
                  const enc = await encryptForRecipients(body, recipients);
                  await editEncNote({ data: { id: n.id, ...enc } });
                  await refetchNotes();
                } else {
                  await updateNoteFn({ data: { id: n.id, body } });
                  await refetchNotes();
                }
                toast.success("Note updated");
              }}
              onDelete={async () => {
                await deleteNoteFn({ data: { id: n.id } });
                await refetchNotes();
                toast.success("Note deleted");
              }}
            />
          ))}
        </div>
      </Card>

      <E2EUnlockModal
        open={unlockOpen}
        onOpenChange={(o) => {
          setUnlockOpen(o);
          if (!o && !e2e.isUnlocked) pendingActionRef.current = null;
        }}
        onUnlocked={async () => {
          await Promise.all([refetchNotes(), loadDirectory()]);
          const queued = pendingActionRef.current;
          if (queued) {
            pendingActionRef.current = null;
            try {
              await queued();
            } catch (err: any) {
              const friendly = friendlyE2EError(err, "post-note");
              toast.error(friendly.title, { description: friendly.description, duration: 8000 });
            }
          }
        }}
      />

      <ConfirmReducedRecipientsDialog
        open={confirmMissingOpen}
        onOpenChange={setConfirmMissingOpen}
        missingRecipients={missingRecipients}
        eligibleRecipientCount={eligibleRecipientCount}
        onCancel={() => { pendingActionRef.current = null; }}
        onConfirm={async () => {
          const fn = pendingActionRef.current;
          pendingActionRef.current = null;
          setRecipientsTouched(true);
          setConfirmMissingOpen(false);
          if (fn) await fn();
        }}
      />
    </>
  );
}
