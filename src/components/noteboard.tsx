import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, LockOpen, ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

import { NoteItem, type Note } from "@/components/note-item";
import { NoteRecipientPicker } from "@/components/note-recipient-picker";
import { E2EUnlockModal } from "@/components/e2e-unlock-modal";

import { supabase } from "@/integrations/supabase/client";
import { addEncryptedNote, listEncryptedNotes, updateEncryptedNote } from "@/lib/encrypted-notes.functions";
import { deleteNote, updateNote } from "@/lib/referrals.functions";
import { getMyPrivateKeyMaterial, getPublicKeyDirectory } from "@/lib/e2e-keys.functions";
import { decryptNote as e2eDecryptNote, encryptNote as e2eEncryptNote } from "@/lib/e2e-crypto";
import { useE2ESession } from "@/hooks/use-e2e-session";
import { useAuth, useRole } from "@/hooks/use-auth";
import { friendlyE2EError } from "@/lib/friendly-e2e-error";
import { cn } from "@/lib/utils";

// Raw ciphertext rows for a referral's notes. Exported so the route loader
// can prime the cache before mount.
export const referralNotesQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ["referrals", "detail", id, "notes"] as const,
    queryFn: () => listEncryptedNotes({ data: { referral_id: id } }),
    staleTime: 5_000,
  });

type DirectoryEntry = { user_id: string; full_name: string; public_key: string | null };

interface NoteboardProps {
  referralId: string;
}

/**
 * End-to-end encrypted noteboard for a referral. Owns:
 *  - the raw notes query + decrypt-into-`notes` pipeline
 *  - the E2E session bootstrap, unlock modal, and queued-action retry
 *  - the recipient directory, chip picker, and reduced-set opt-in dialog
 *  - realtime subscriptions for notes + public-key directory changes
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
  const [notes, setNotes] = useState<Note[]>([]);
  const [authors, setAuthors] = useState<Record<string, string>>({});
  const [noteBody, setNoteBody] = useState("");
  const [posting, setPosting] = useState(false);
  const [noteFilter, setNoteFilter] = useState<"all" | "e2e" | "legacy" | "failed">("all");

  const [unlockOpen, setUnlockOpen] = useState(false);
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const [confirmMissingOpen, setConfirmMissingOpen] = useState(false);
  const [ackReducedSet, setAckReducedSet] = useState(false);
  const pendingActionRef = useRef<null | (() => Promise<void>)>(null);
  const [selectedRecipients, setSelectedRecipients] = useState<Set<string>>(new Set());
  const [recipientsTouched, setRecipientsTouched] = useState(false);
  // Teammates who published/rotated a key since this session loaded the
  // directory — highlighted in the compose chip row so the author immediately
  // sees who just became eligible.
  const [newlyEligibleIds, setNewlyEligibleIds] = useState<Set<string>>(new Set());

  const refetchNotes = () =>
    queryClient.invalidateQueries({ queryKey: referralNotesQueryOptions(id).queryKey });

  const loadDirectory = async () => {
    try {
      const d = (await fetchKeyDir({ data: undefined as any })) as any[];
      const list = (d ?? []) as DirectoryEntry[];
      setDirectory((prev) => {
        const wasMissing = new Map(prev.map((r) => [r.user_id, !r.public_key] as const));
        const newlyEnrolled = list.filter(
          (r) => r.public_key && wasMissing.get(r.user_id) === true && r.user_id !== user?.id,
        );
        if (newlyEnrolled.length > 0 && prev.length > 0) {
          const names = newlyEnrolled.map((r) => r.full_name).slice(0, 3).join(", ");
          const extra = newlyEnrolled.length > 3 ? ` and ${newlyEnrolled.length - 3} more` : "";
          toast.success(`${names}${extra} enabled encryption — recipients updated.`);
          const freshIds = newlyEnrolled.map((r) => r.user_id);
          setNewlyEligibleIds((cur) => {
            const next = new Set(cur);
            freshIds.forEach((uid) => next.add(uid));
            return next;
          });
          window.setTimeout(() => {
            setNewlyEligibleIds((cur) => {
              const next = new Set(cur);
              freshIds.forEach((uid) => next.delete(uid));
              return next;
            });
          }, 45_000);
        }
        return list;
      });
      return list;
    } catch { return null; }
  };

  useEffect(() => { if (user) loadDirectory(); /* eslint-disable-next-line */ }, [user?.id, e2e.isUnlocked]);

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
        const res: any = await fetchKeyMaterial({ data: undefined as any });
        e2e.setMaterial(res?.material ?? null, res?.public_key ?? null);
      } catch { /* non-fatal */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useEffect(() => {
    if (!e2e.isUnlocked) return;
    loadDirectory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e2e.isUnlocked]);

  const decryptNoteRow = async (n: any): Promise<Note> => {
    if (n.body_ciphertext && n.body_nonce) {
      if (!n.wrapped_key) return { ...n, body: null, _e2eStatus: "e2e-no-key" };
      if (!e2e.isUnlocked || !e2e.privateKey || !e2e.publicKey) {
        return { ...n, body: null, _e2eStatus: "e2e-locked" };
      }
      try {
        const body = await e2eDecryptNote(
          { body_ciphertext: n.body_ciphertext, body_nonce: n.body_nonce, wrapped_key: n.wrapped_key },
          { publicKey: e2e.publicKey, privateKey: e2e.privateKey },
        );
        return { ...n, body, _e2eStatus: "e2e-decrypted" };
      } catch {
        return { ...n, body: null, _e2eStatus: "e2e-failed" };
      }
    }
    if (n.body_enc) return { ...n, _e2eStatus: "legacy-server-enc" };
    return { ...n, _e2eStatus: "plaintext" };
  };

  // Decrypt whenever the ciphertext rows or the E2E session change. Cancel
  // stale runs so a fast succession of updates (post → realtime → unlock)
  // can't have an earlier decryption overwrite a newer one.
  useEffect(() => {
    if (!rawNotes) return;
    let cancelled = false;
    const sorted = [...rawNotes].sort(
      (a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    (async () => {
      const decrypted = await Promise.all(sorted.map((n) => decryptNoteRow(n)));
      if (!cancelled) setNotes(decrypted);
    })();
    const ids = Array.from(new Set(sorted.map((n: any) => n.author_id))) as string[];
    if (ids.length) {
      supabase
        .from("profiles")
        .select("id,full_name")
        .in("id", ids)
        .then(({ data: ps }) => {
          if (cancelled || !ps) return;
          const map: Record<string, string> = {};
          ps.forEach((p) => { map[p.id] = p.full_name ?? "Clinician"; });
          setAuthors((cur) => ({ ...cur, ...map }));
        });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawNotes, e2e.isUnlocked, e2e.privateKey, e2e.publicKey]);

  // Realtime: refetch notes on any change; refresh directory on key changes.
  useEffect(() => {
    const ch = supabase
      .channel(`ref-notes-${id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "referral_notes", filter: `referral_id=eq.${id}` },
        () => { refetchNotes(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "user_public_keys" },
        () => { loadDirectory(); })
      .subscribe();

    const refresh = () => { loadDirectory(); };
    const onVis = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", onVis);

    return () => {
      supabase.removeChannel(ch);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const directoryWithSelf: DirectoryEntry[] = (() => {
    if (!user?.id || !e2e.publicKey) return directory;
    if (directory.some((r) => r.user_id === user.id)) return directory;
    return [...directory, { user_id: user.id, full_name: "You", public_key: e2e.publicKey }];
  })();

  const missingRecipients = directory.filter((r) => !r.public_key && r.user_id !== user?.id);
  const eligibleRecipientCount = Array.from(selectedRecipients).length;
  const excludedMissingKey = directory.filter(
    (r) => r.user_id !== user?.id && !r.public_key,
  );
  const excludedDeselected = directory.filter(
    (r) => r.user_id !== user?.id && !!r.public_key && !selectedRecipients.has(r.user_id),
  );
  const partialCoverage =
    eligibleRecipientCount > 0 && (excludedMissingKey.length + excludedDeselected.length) > 0;

  const encryptForRecipients = async (body: string, recipientIds: Set<string>) => {
    const dir = await fetchKeyDir({ data: undefined as any });
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
        {e2e.isUnlocked && missingRecipients.length > 0 && (
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
        )}
        {e2e.isUnlocked && partialCoverage && (recipientsTouched || excludedDeselected.length > 0) && (
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
                  <ul className="list-disc pl-5 text-xs max-h-24 overflow-auto">
                    {excludedDeselected.slice(0, 8).map((r) => (
                      <li key={r.user_id}>{r.full_name}</li>
                    ))}
                    {excludedDeselected.length > 8 && <li>and {excludedDeselected.length - 8} more…</li>}
                  </ul>
                </div>
              )}
              {excludedMissingKey.length > 0 && (
                <div>
                  <div className="text-[11px] font-medium uppercase tracking-wide opacity-80">
                    No encryption key yet ({excludedMissingKey.length})
                  </div>
                  <ul className="list-disc pl-5 text-xs max-h-24 overflow-auto">
                    {excludedMissingKey.slice(0, 8).map((r) => (
                      <li key={r.user_id}>{r.full_name}</li>
                    ))}
                    {excludedMissingKey.length > 8 && <li>and {excludedMissingKey.length - 8} more…</li>}
                  </ul>
                </div>
              )}
            </AlertDescription>
          </Alert>
        )}
        <div className="space-y-2 mb-4">
          {e2e.isUnlocked && directoryWithSelf.length > 0 && (
            <div className="flex flex-wrap gap-1.5 rounded-md border bg-muted/30 p-2">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground self-center mr-1">
                Recipient keys
              </span>
              {[...directoryWithSelf]
                .sort((a, b) => {
                  const na = newlyEligibleIds.has(a.user_id) ? 0 : 1;
                  const nb = newlyEligibleIds.has(b.user_id) ? 0 : 1;
                  if (na !== nb) return na - nb;
                  const ka = a.public_key ? 0 : 1;
                  const kb = b.public_key ? 0 : 1;
                  if (ka !== kb) return ka - kb;
                  return a.full_name.localeCompare(b.full_name);
                })
                .map((r) => {
                  const isMe = r.user_id === user?.id;
                  const hasKey = !!r.public_key;
                  const isSelected = selectedRecipients.has(r.user_id);
                  const isNew = newlyEligibleIds.has(r.user_id);
                  const status: "selected" | "deselected" | "blocked" = !hasKey
                    ? "blocked"
                    : isSelected
                      ? "selected"
                      : "deselected";
                  const styles = {
                    selected:
                      "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20",
                    deselected:
                      "border-border bg-background text-muted-foreground hover:bg-accent",
                    blocked:
                      "border-destructive/40 bg-destructive/10 text-destructive cursor-not-allowed",
                  }[status];
                  const Icon =
                    status === "blocked"
                      ? ShieldAlert
                      : status === "selected"
                        ? ShieldCheck
                        : ShieldOff;
                  const title =
                    status === "blocked"
                      ? `${r.full_name} — no published encryption key. Ask them to enable encryption on the noteboard.`
                      : status === "selected"
                        ? `${r.full_name} — will be able to decrypt this note.${isNew ? " Just enabled encryption." : ""}`
                        : `${r.full_name} — has a key but is not a recipient of this note. Click to include.`;
                  return (
                    <button
                      key={r.user_id}
                      type="button"
                      disabled={!hasKey}
                      onClick={() => {
                        if (!hasKey) return;
                        setRecipientsTouched(true);
                        const next = new Set(selectedRecipients);
                        if (next.has(r.user_id)) next.delete(r.user_id);
                        else next.add(r.user_id);
                        setSelectedRecipients(next);
                      }}
                      title={title}
                      className={cn(
                        "relative inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors",
                        styles,
                        isNew && "ring-2 ring-sky-400 ring-offset-1 ring-offset-background",
                      )}
                    >
                      <Icon className="w-3 h-3" />
                      <span className="max-w-[9rem] truncate">
                        {r.full_name}
                        {isMe && <span className="ml-1 opacity-70">(you)</span>}
                      </span>
                      {isNew && (
                        <span className="ml-1 rounded bg-sky-500/20 px-1 text-[9px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">
                          New
                        </span>
                      )}
                    </button>
                  );
                })}
            </div>
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

      <AlertDialog
        open={confirmMissingOpen}
        onOpenChange={(o) => { setConfirmMissingOpen(o); if (!o) setAckReducedSet(false); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-destructive" />
              Posting blocked — {missingRecipients.length} teammate{missingRecipients.length === 1 ? "" : "s"} can't read this note
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <div>
                  These teammates haven't enrolled in end-to-end encryption, so this note
                  <strong> cannot be encrypted for them</strong> — even later, after they enroll.
                </div>
                <ul className="list-disc pl-5 text-xs max-h-32 overflow-auto">
                  {missingRecipients.map((r) => (
                    <li key={r.user_id}>{r.full_name}</li>
                  ))}
                </ul>
                <div>
                  To continue, explicitly opt into posting to a reduced recipient set
                  ({eligibleRecipientCount} enrolled teammate{eligibleRecipientCount === 1 ? "" : "s"}).
                  Otherwise, cancel and ask them to enable encryption first.
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm cursor-pointer">
            <Checkbox
              checked={ackReducedSet}
              onCheckedChange={(v) => setAckReducedSet(v === true)}
              className="mt-0.5"
            />
            <span>
              I understand the excluded teammates will never be able to read this note,
              and I want to post it to the reduced recipient set anyway.
            </span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { pendingActionRef.current = null; setAckReducedSet(false); }}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={!ackReducedSet}
              onClick={async () => {
                if (!ackReducedSet) return;
                const fn = pendingActionRef.current;
                pendingActionRef.current = null;
                setRecipientsTouched(true);
                setConfirmMissingOpen(false);
                setAckReducedSet(false);
                if (fn) await fn();
              }}
            >
              Post to reduced recipient set
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
