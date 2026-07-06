import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { deleteNote, deleteReferral, findReferralsByHospitalNumber, getNoteHistory, getReferralDetail, logReferralView, updateNote, updateReferral, type DecryptedReferral, type DecryptedReferralNote } from "@/lib/referrals.functions";
import { ReferralAuditTrail } from "@/components/referral-audit-trail";
import { addEncryptedNote, listEncryptedNotes, updateEncryptedNote } from "@/lib/encrypted-notes.functions";
import { getMyPrivateKeyMaterial, getPublicKeyDirectory } from "@/lib/e2e-keys.functions";
import { decryptNote as e2eDecryptNote, encryptNote as e2eEncryptNote } from "@/lib/e2e-crypto";
import { useE2ESession } from "@/hooks/use-e2e-session";
import { E2EUnlockModal } from "@/components/e2e-unlock-modal";
import { useAuth, useRole } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import type { Tables } from "@/integrations/supabase/types";
import { ComboboxAdd } from "@/components/combobox-add";
import { useReferralOptions } from "@/hooks/use-referral-options";
import { NoteRecipientPicker } from "@/components/note-recipient-picker";
import { ArrowLeft, History, Pencil, Save, Trash2, X, ChevronDown, AlertCircle, Lock, LockOpen, ShieldAlert, ShieldCheck, ShieldOff, Users } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { format, formatDistanceToNow } from "date-fns";
import { tzTooltip } from "@/lib/format-timestamp";
import { toast } from "sonner";
import { friendlyE2EError } from "@/lib/friendly-e2e-error";
import { validateReferralTimings } from "@/lib/referral-validation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ADMISSION_URGENCY_OPTIONS, type AdmissionUrgency } from "@/lib/admission-urgency";
import { cn } from "@/lib/utils";


type Referral = Tables<"referrals"> & DecryptedReferral;
type Note = Tables<"referral_notes"> & DecryptedReferralNote & {
  wrapped_key?: string | null;
  body_ciphertext?: string | null;
  body_nonce?: string | null;
  enc_version?: number | null;
  recipient_user_ids?: string[];
  _e2eStatus?: "plaintext" | "legacy-server-enc" | "e2e-decrypted" | "e2e-locked" | "e2e-no-key" | "e2e-failed";
};

// Queryable cache key for a single referral's decrypted detail. The loader
// primes this so navigation from the list page shows data on first paint;
// the component still owns local `ref` state for form edits (to avoid
// realtime refetches clobbering unsaved input), but seeds it from the cache.
const referralDetailQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ["referrals", "detail", id] as const,
    queryFn: () => getReferralDetail({ data: { id } }),
    staleTime: 5_000,
  });

// Raw (still-ciphertext) notes for a referral. The loader primes this so the
// noteboard has data on first paint; the component owns a derived
// `decryptedNotes` state because decryption requires the unlocked E2E key,
// which isn't available during SSR/prerender.
const referralNotesQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ["referrals", "detail", id, "notes"] as const,
    queryFn: () => listEncryptedNotes({ data: { referral_id: id } }),
    staleTime: 5_000,
  });

export const Route = createFileRoute("/_authenticated/referrals/$id")({
  validateSearch: (search: Record<string, unknown>) => ({
    highlight: typeof search.highlight === "string" ? search.highlight : undefined,
  }),
  head: () => ({ meta: [{ title: "Referral — SDH Critical Care" }, { name: "robots", content: "noindex" }] }),
  loader: ({ context, params }) => {
    context.queryClient.ensureQueryData(referralNotesQueryOptions(params.id));
    return context.queryClient.ensureQueryData(referralDetailQueryOptions(params.id));
  },
  component: ReferralDetail,
});


function toLocal(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function ReferralDetail() {
  const { id } = Route.useParams();
  const { highlight } = Route.useSearch();
  const navigate = useNavigate();
  const update = useServerFn(updateReferral);
  // Legacy non-E2E addNote path is intentionally removed — new notes always
  // go through the end-to-end encrypted `submitEncNote` flow below.
  const updateNoteFn = useServerFn(updateNote);
  const deleteNoteFn = useServerFn(deleteNote);
  const logView = useServerFn(logReferralView);
  const removeReferral = useServerFn(deleteReferral);
  // Audit-trail state was extracted into <ReferralAuditTrail>. Note-history
  // fetch below is a separate feature and stays put.
  const { user } = useAuth();
  const { hasRole: isAdmin } = useRole("admin");
  const [deleting, setDeleting] = useState(false);
  const [expandCmd, setExpandCmd] = useState<{ open: boolean; id: number } | null>(null);
  const { specialties, wards, consultants } = useReferralOptions();


  // Seed from the loader-primed cache so the initial paint has data. Local
  // state still owns edits (controlled form inputs) — realtime UPDATE calls
  // `loadRef` below to refresh the cache and the local state together.
  const queryClient = useQueryClient();
  const [ref, setRef] = useState<Referral | null>(
    () => (queryClient.getQueryData(referralDetailQueryOptions(id).queryKey) as Referral | null) ?? null,
  );

  // Raw ciphertext rows come from the query cache (loader-primed).
  // `notes` below is the decrypted, sorted-newest-first projection that the
  // UI actually renders; it's derived in an effect whenever the raw rows or
  // the E2E session change.
  const { data: rawNotes } = useQuery(referralNotesQueryOptions(id));
  const [notes, setNotes] = useState<Note[]>([]);
  const [authors, setAuthors] = useState<Record<string, string>>({});
  const [noteBody, setNoteBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [posting, setPosting] = useState(false);
  const [priorDeclined, setPriorDeclined] = useState<Referral[]>([]);
  const [noteFilter, setNoteFilter] = useState<"all" | "e2e" | "legacy" | "failed">("all");
  const outcomeRef = useRef<HTMLDivElement>(null);

  // (Audit-trail IntersectionObserver moved into <ReferralAuditTrail>.)


  useEffect(() => {
    if (highlight === "declined" && ref?.status === "declined" && outcomeRef.current) {
      outcomeRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
      outcomeRef.current.classList.add("ring-2", "ring-destructive", "ring-offset-2", "rounded-xl");
      const timer = setTimeout(() => {
        outcomeRef.current?.classList.remove("ring-2", "ring-destructive", "ring-offset-2", "rounded-xl");
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [highlight, ref?.status]);

  // Author names are batch-fetched inside `loadNotes` in a single query
  // over all note author ids; no per-author fetch on realtime updates —
  // any new note triggers a refetch that re-batches names too.

  const fetchDetail = useServerFn(getReferralDetail);
  const fetchNotes = useServerFn(listEncryptedNotes);
  const fetchPriors = useServerFn(findReferralsByHospitalNumber);
  const fetchKeyMaterial = useServerFn(getMyPrivateKeyMaterial);
  const fetchKeyDir = useServerFn(getPublicKeyDirectory);
  const submitEncNote = useServerFn(addEncryptedNote);
  const editEncNote = useServerFn(updateEncryptedNote);

  const e2e = useE2ESession();
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [directory, setDirectory] = useState<Array<{ user_id: string; full_name: string; public_key: string | null }>>([]);
  const [confirmMissingOpen, setConfirmMissingOpen] = useState(false);
  const [ackReducedSet, setAckReducedSet] = useState(false);
  const pendingActionRef = useRef<null | (() => Promise<void>)>(null);
  const [selectedRecipients, setSelectedRecipients] = useState<Set<string>>(new Set());
  const [recipientsTouched, setRecipientsTouched] = useState(false);
  // Teammates who published/rotated a key since this session loaded the
  // directory — highlighted in the compose chip row so the author immediately
  // sees who just became eligible.
  const [newlyEligibleIds, setNewlyEligibleIds] = useState<Set<string>>(new Set());

  const loadDirectory = async () => {
    try {
      const d = (await fetchKeyDir({ data: undefined as any })) as any[];
      const list = (d ?? []) as Array<{ user_id: string; full_name: string; public_key: string | null }>;
      setDirectory((prev) => {
        // Detect teammates who newly published a key since the last snapshot
        // and surface it — helps the author know the block might now lift.
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
            freshIds.forEach((id) => next.add(id));
            return next;
          });
          // Auto-fade the "new" highlight after 45s so it stays informative.
          window.setTimeout(() => {
            setNewlyEligibleIds((cur) => {
              const next = new Set(cur);
              freshIds.forEach((id) => next.delete(id));
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

  const directoryWithSelf = (() => {
    if (!user?.id || !e2e.publicKey) return directory;
    if (directory.some((r) => r.user_id === user.id)) return directory;
    return [...directory, { user_id: user.id, full_name: "You", public_key: e2e.publicKey }];
  })();

  const missingRecipients = directory.filter((r) => !r.public_key && r.user_id !== user?.id);
  const eligibleRecipientCount = Array.from(selectedRecipients).length;
  // Teammates who will NOT be able to read the note as currently composed —
  // split by reason so the inline warning can spell out exactly who is excluded.
  const excludedMissingKey = directory.filter(
    (r) => r.user_id !== user?.id && !r.public_key,
  );
  const excludedDeselected = directory.filter(
    (r) => r.user_id !== user?.id && !!r.public_key && !selectedRecipients.has(r.user_id),
  );
  const partialCoverage =
    eligibleRecipientCount > 0 && (excludedMissingKey.length + excludedDeselected.length) > 0;

  const loadRef = async () => {
    try {
      const r = await fetchDetail({ data: { id } });
      setRef(r as Referral | null);
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to load referral");
    }
  };

  // Bootstrap E2E session: rehydrate a persisted unlock (sessionStorage)
  // before falling back to fetching the stored key material.
  useEffect(() => {
    if (!user) return;
    if (e2e.material || e2e.needsBootstrap) return;
    (async () => {
      // Restore an unlocked session if one is cached for this tab.
      if (!e2e.hydrated) await e2e.hydrateFromSession();
      try {
        const res: any = await fetchKeyMaterial({ data: undefined as any });
        e2e.setMaterial(res?.material ?? null, res?.public_key ?? null);
      } catch { /* non-fatal */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Once we're unlocked (fresh or rehydrated), refresh the directory so the
  // compose UI shows enrolled teammates. Note decryption is handled by the
  // effect below, which re-runs on `e2e.isUnlocked` automatically.
  useEffect(() => {
    if (!e2e.isUnlocked) return;
    loadDirectory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e2e.isUnlocked]);


  const refetchNotes = () =>
    queryClient.invalidateQueries({ queryKey: referralNotesQueryOptions(id).queryKey });

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
    // Batch-fetch author display names for the current row set.
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

  useEffect(() => {
    logView({ data: { referral_id: id } }).catch(() => {});
    loadRef();

    // Realtime payloads contain ciphertext, so we use them only as a
    // signal to refetch via the decrypting server fn.
    const ch = supabase
      .channel(`ref-${id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "referrals", filter: `id=eq.${id}` },
        () => { loadRef(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "referral_notes", filter: `referral_id=eq.${id}` },
        () => { refetchNotes(); })
      // A teammate publishing / rotating / removing their public key changes
      // who this note can be encrypted for. Refresh the directory live so the
      // compose UI and the missing-recipients block reflect reality.
      .on("postgres_changes", { event: "*", schema: "public", table: "user_public_keys" },
        () => { loadDirectory(); })
      .subscribe();

    // Also re-check when the tab regains focus / comes back online, in case
    // realtime dropped an event while the tab was backgrounded.
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


  // Fetch other declined referrals for the same patient.
  useEffect(() => {
    const hn = ref?.hospital_number?.trim();
    if (!hn) {
      setPriorDeclined([]);
      return;
    }
    let cancelled = false;
    fetchPriors({ data: { hospital_number: hn, exclude_id: id } })
      .then((rows: any[]) => {
        if (cancelled) return;
        setPriorDeclined(((rows ?? []) as Referral[]).filter((r) => r.status === "declined"));
      })
      .catch(() => { if (!cancelled) setPriorDeclined([]); });
    return () => { cancelled = true; };
  }, [ref?.hospital_number, id, fetchPriors]);



  const filteredNotes = notes.filter((n) => {
    if (noteFilter === "all") return true;
    if (noteFilter === "e2e") return n._e2eStatus === "e2e-decrypted" || n._e2eStatus === "e2e-locked" || n._e2eStatus === "e2e-no-key" || n._e2eStatus === "e2e-failed";
    if (noteFilter === "legacy") return n._e2eStatus === "legacy-server-enc" || n._e2eStatus === "plaintext";
    if (noteFilter === "failed") return n._e2eStatus === "e2e-failed";
    return true;
  });

  if (!ref) return <div className="p-6 text-muted-foreground">Loading…</div>;

  const canDelete = !!user && (user.id === ref.created_by || isAdmin);

  const set = (k: keyof Referral, v: any) => setRef({ ...ref, [k]: v });

  const timing = validateReferralTimings({
    status: ref.status,
    referral_received_at: ref.referral_received_at,
    first_seen_at: ref.first_seen_at,
    decision_at: ref.decision_at,
    arrived_on_unit_at: ref.arrived_on_unit_at,
  });

  const declineReasonMissing =
    ref.status === "declined" && !(ref.decline_reason ?? "").trim();
  const declineConsultantMissing =
    ref.status === "declined" && !((ref as any).discussed_with_consultant ?? "").trim();
  const acceptingConsultantMissing =
    (ref.status === "admitted" || ref.status === "accepted") && !((ref as any).accepting_consultant ?? "").trim();

  const save = async () => {
    if (!timing.isValid) {
      toast.error("Please fix the highlighted timing issues before saving.");
      return;
    }
    if (declineReasonMissing) {
      toast.error("A reason is required when declining a referral.");
      return;
    }
    if (declineConsultantMissing) {
      toast.error("Please record which critical care consultant the referral was discussed with.");
      return;
    }
    if (acceptingConsultantMissing) {
      toast.error("Please select the accepting critical care consultant before marking this referral as Accepted or Admitted.");
      return;
    }
    setSaving(true);
    try {
      const patch: any = {
        age: ref.age, sex: ref.sex, hospital_number: ref.hospital_number,
        current_ward: ref.current_ward, current_bed: ref.current_bed,
        past_medical_history: ref.past_medical_history, baseline_function: ref.baseline_function,
        dnacpr_respect: ref.dnacpr_respect, referring_specialty: ref.referring_specialty,
        consultant_to_consultant_only: (ref as any).consultant_to_consultant_only ?? false,
        reason_for_referral: ref.reason_for_referral, status: ref.status,
        decline_reason: ref.decline_reason,
        discussed_with_consultant: (ref as any).discussed_with_consultant ?? null,
        admission_urgency: ref.admission_urgency ?? null,
        accepting_consultant: (ref as any).accepting_consultant ?? null,
        referral_received_at: ref.referral_received_at,
        first_seen_at: ref.first_seen_at, decision_at: ref.decision_at,
        arrived_on_unit_at: ref.arrived_on_unit_at,
        is_test: (ref as any).is_test ?? false,
      };
      await update({ data: { id: ref.id, patch } });
      toast.success("Saved");
    } catch (err: any) {
      toast.error(err.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const encryptForRecipients = async (body: string, recipientIds: Set<string>) => {
    const dir = await fetchKeyDir({ data: undefined as any });
    const byId = new Map<string, string>();
    for (const r of (dir ?? []) as any[]) {
      if (r.public_key) byId.set(r.user_id, r.public_key as string);
    }
    // Ensure the author can decrypt their own note if selected.
    if (e2e.publicKey && user && !byId.has(user.id)) byId.set(user.id, e2e.publicKey);
    const recipients = Array.from(recipientIds)
      .filter((id) => byId.has(id))
      .map((id) => ({ user_id: id, public_key: byId.get(id)! }));
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
          // Server re-checks recipient coverage against the live key
          // directory. Only pass the opt-in flag when the author has
          // knowingly reduced the recipient set (touched the picker or
          // confirmed the reduced-set dialog).
          allow_reduced_recipients: recipientsTouched,
        },
      });
      setNoteBody("");
    } catch (err: any) {
      const msg = String(err?.message ?? "");
      const marker = "RECIPIENT_COVERAGE_CHANGED::";
      const idx = msg.indexOf(marker);
      if (idx >= 0) {
        // Structured coverage-change from the server. Parse the JSON payload,
        // refresh the local directory, and show a detailed toast so the
        // author knows exactly who to re-review.
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
    // Refresh directory just before posting so the check reflects reality.
    const list = await loadDirectory();
    const missing = (list ?? directory).filter(
      (r) => !r.public_key && r.user_id !== user?.id,
    );
    // Hard block: if any teammate is missing a public key and the author
    // has NOT explicitly changed the recipient set, force them to open the
    // picker and opt into a reduced set first.
    if (missing.length > 0 && !recipientsTouched) {
      pendingActionRef.current = doPostNote;
      setConfirmMissingOpen(true);
      return;
    }
    await doPostNote();
  };



  const onDelete = async () => {
    setDeleting(true);
    try {
      await removeReferral({ data: { id } });
      toast.success("Referral deleted");
      navigate({ to: "/" });
    } catch (err: any) {
      toast.error(err.message ?? "Delete failed");
      setDeleting(false);
    }
  };

  const saveTimestamp = async (key: keyof Referral, iso: string | null) => {
    setRef({ ...ref, [key]: iso } as Referral);
    try {
      await update({ data: { id, patch: { [key]: iso } } });
      toast.success("Saved", { duration: 1200 });
    } catch (err: any) {
      toast.error(err.message ?? "Auto-save failed");
    }
  };

  const statusStyles: Record<string, string> = {
    pending: "bg-warning/15 text-warning-foreground border-warning/30",
    admitted: "bg-success/15 text-success border-success/30",
    declined: "bg-destructive/10 text-destructive border-destructive/30",
  };

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between gap-2 mb-6 flex-wrap">
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: "/" })}><ArrowLeft className="w-4 h-4 mr-1" /> Back to list</Button>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={`capitalize ${statusStyles[ref.status]}`}>{ref.status}</Badge>
          {canDelete && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" className="text-destructive hover:text-destructive">
                  <Trash2 className="w-4 h-4 mr-1" /> Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this referral?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently removes the referral and its notes. The deletion is recorded in the audit log. This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={onDelete} disabled={deleting} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                    {deleting ? "Deleting…" : "Delete referral"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      <h1 className="text-2xl font-semibold mb-1">
        {ref.hospital_number ?? "Referral"} · {ref.age ?? "?"}/{ref.sex ?? "?"}
      </h1>
      <p className="text-sm text-muted-foreground mb-2" title={tzTooltip(ref.referral_received_at)}>
        Received {format(new Date(ref.referral_received_at), "dd/MM/yyyy HH:mm:ss")}
      </p>
      <div className="flex gap-2 mb-4 md:hidden">
        <Button
          size="sm"
          variant="outline"
          className="flex-1"
          onClick={() => setExpandCmd({ open: true, id: Date.now() })}
        >
          Expand all
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="flex-1"
          onClick={() => setExpandCmd({ open: false, id: Date.now() })}
        >
          Collapse all
        </Button>
      </div>

      <div className="space-y-4">
        <Card className="p-5 space-y-4">
          <h2 className="font-semibold">Details</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <F label="Age"><Input type="number" value={ref.age ?? ""} onChange={(e) => set("age", e.target.value ? Number(e.target.value) : null)} /></F>
            <F label="Sex">
              <Select value={ref.sex ?? "unknown"} onValueChange={(v) => set("sex", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["male","female","other","unknown"].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </F>
            <F label="Hospital number"><Input value={ref.hospital_number ?? ""} onChange={(e) => set("hospital_number", e.target.value)} /></F>
            <F label="Referring specialty"><ComboboxAdd value={ref.referring_specialty ?? ""} onChange={(v) => set("referring_specialty", v)} options={specialties} /></F>
            <F label="Ward"><ComboboxAdd value={ref.current_ward ?? ""} onChange={(v) => set("current_ward", v)} options={wards} /></F>
            <F label="Bed"><Input value={ref.current_bed ?? ""} onChange={(e) => set("current_bed", e.target.value)} /></F>
          </div>
          <ExpandableSection label="Past medical history" command={expandCmd}><Textarea rows={3} value={ref.past_medical_history ?? ""} onChange={(e) => set("past_medical_history", e.target.value)} /></ExpandableSection>
          <ExpandableSection label="Baseline function" command={expandCmd}><Textarea rows={2} value={ref.baseline_function ?? ""} onChange={(e) => set("baseline_function", e.target.value)} /></ExpandableSection>
          <ExpandableSection label="Reason for referral" command={expandCmd}><Textarea rows={3} value={ref.reason_for_referral ?? ""} onChange={(e) => set("reason_for_referral", e.target.value)} /></ExpandableSection>
          <div className="flex items-center gap-3">
            <Switch checked={ref.dnacpr_respect} onCheckedChange={(v) => set("dnacpr_respect", v)} id="dn" />
            <Label htmlFor="dn">DNACPR / ReSPECT in place</Label>
          </div>
          <div className="flex items-center gap-3">
            <Switch
              checked={(ref as any).consultant_to_consultant_only ?? false}
              onCheckedChange={(v) => set("consultant_to_consultant_only" as any, v as any)}
              id="c2c"
            />
            <Label htmlFor="c2c">Consultant-to-consultant referral only</Label>
          </div>
          <div className="flex items-start justify-between gap-4 rounded-md border border-amber-400/60 bg-amber-50/40 dark:bg-amber-950/20 p-3">
            <div>
              <Label htmlFor="is-test" className="text-sm font-medium cursor-pointer">
                Test / demonstration referral
              </Label>
              <p className="text-xs text-muted-foreground">
                Not a real patient. Test referrals show a badge on the list and
                are excluded from analytics.
              </p>
            </div>
            <Switch
              id="is-test"
              checked={(ref as any).is_test ?? false}
              onCheckedChange={(v) => set("is_test" as any, v as any)}
            />
          </div>
        </Card>


        {priorDeclined.length > 0 && (
          <Card className="p-5 space-y-3 border-destructive/40">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-destructive" />
              <h2 className="font-semibold text-destructive">
                Previously declined critical care referral{priorDeclined.length > 1 ? "s" : ""} for this patient
              </h2>
            </div>
            <p className="text-xs text-muted-foreground">
              Same hospital number ({ref.hospital_number}). Full decline reasons shown below.
            </p>
            <div className="space-y-3">
              {priorDeclined.map((p) => {
                const when = p.decision_at ?? p.referral_received_at;
                return (
                  <div key={p.id} className="border rounded-md p-3 bg-destructive/5">
                    <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                      <div className="text-sm font-medium" title={when ? tzTooltip(when) : undefined}>
                        Declined {when ? format(new Date(when), "dd/MM/yyyy HH:mm") : "date unknown"}
                        {p.referring_specialty ? ` · ${p.referring_specialty}` : ""}
                      </div>
                      <Link
                        to="/referrals/$id"
                        params={{ id: p.id }}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs underline text-muted-foreground hover:text-foreground"
                      >
                        Open full referral
                      </Link>
                    </div>
                    <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                      Reason for declining
                    </div>
                    {p.decline_reason ? (
                      <p className="text-sm whitespace-pre-wrap">{p.decline_reason}</p>
                    ) : (
                      <p className="text-sm italic text-muted-foreground">No reason recorded.</p>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        )}



        <Card className="p-5 space-y-4">
          <h2 className="font-semibold">Timeline (ICNARC)</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <F label="Received" required error={timing.fieldErrors.referral_received_at}>
              <DTNow value={toLocal(ref.referral_received_at)} onChange={(v) => saveTimestamp("referral_received_at", v ? new Date(v).toISOString() : null)} invalid={!!timing.fieldErrors.referral_received_at} />
            </F>
            <F label="First seen" required={ref.status !== "pending"} error={timing.fieldErrors.first_seen_at}>
              <DTNow value={toLocal(ref.first_seen_at)} onChange={(v) => saveTimestamp("first_seen_at", v ? new Date(v).toISOString() : null)} invalid={!!timing.fieldErrors.first_seen_at} />
            </F>
            <F label="Decision" required={ref.status !== "pending"} error={timing.fieldErrors.decision_at}>
              <DTNow value={toLocal(ref.decision_at)} onChange={(v) => saveTimestamp("decision_at", v ? new Date(v).toISOString() : null)} invalid={!!timing.fieldErrors.decision_at} />
            </F>
            <F label="Arrived on unit" required={ref.status === "admitted"} error={timing.fieldErrors.arrived_on_unit_at}>
              <DTNow value={toLocal(ref.arrived_on_unit_at)} onChange={(v) => saveTimestamp("arrived_on_unit_at", v ? new Date(v).toISOString() : null)} disabled={ref.status === "declined"} invalid={!!timing.fieldErrors.arrived_on_unit_at} />
            </F>
          </div>
          {timing.issues.length > 0 && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Inconsistent timings</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4 space-y-1">
                  {timing.issues.map((m) => <li key={m}>{m}</li>)}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          <p className="text-xs text-muted-foreground">Timestamps save automatically. Fields marked <span className="text-destructive">*</span> are required for the ICNARC dataset.</p>
        </Card>

        <Card ref={outcomeRef} className="p-5 space-y-4">
          <h2 className="font-semibold">Outcome</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <F label="Status">
              <Select value={ref.status} onValueChange={(v) => {
                const next: Partial<Referral> = { status: v as Referral["status"] };
                if ((v === "accepted" || v === "admitted") && !ref.decision_at) {
                  next.decision_at = new Date().toISOString();
                }
                setRef({ ...ref, ...next });
              }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="accepted">Accepted</SelectItem>
                  <SelectItem value="admitted">Admitted</SelectItem>
                  <SelectItem value="declined">Declined</SelectItem>
                </SelectContent>
              </Select>
            </F>
            <F label="Admission urgency">
              <Select
                value={ref.admission_urgency ?? "none"}
                onValueChange={(v) =>
                  set("admission_urgency", v === "none" ? null : (v as AdmissionUrgency))
                }
              >
                <SelectTrigger><SelectValue placeholder="Not specified" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not specified</SelectItem>
                  {ADMISSION_URGENCY_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </F>
          </div>
          {ref.status === "declined" && (
            <>
              <ExpandableSection label="Reason for declining" command={expandCmd}>
                <Textarea
                  rows={3}
                  value={ref.decline_reason ?? ""}
                  onChange={(e) => set("decline_reason", e.target.value)}
                  className={declineReasonMissing ? "border-destructive focus-visible:ring-destructive" : undefined}
                />
                {declineReasonMissing && (
                  <p className="text-xs text-destructive mt-1">Required when declining a referral.</p>
                )}
              </ExpandableSection>
              <F label="Discussed with critical care consultant" required error={declineConsultantMissing ? "Required when declining a referral." : undefined}>
                <div className={cn(declineConsultantMissing && "rounded-md ring-1 ring-destructive")}>
                  <ComboboxAdd
                    value={(ref as any).discussed_with_consultant ?? ""}
                    onChange={(v) => set("discussed_with_consultant" as any, (v || null) as any)}
                    options={consultants}
                    placeholder="Select or add consultant…"
                  />
                </div>
              </F>
            </>
          )}
          {(ref.status === "admitted" || ref.status === "accepted") && (
            <F label="Accepting critical care consultant" required error={acceptingConsultantMissing ? "Required when a referral is accepted or admitted." : undefined}>
              <div className={cn(acceptingConsultantMissing && "rounded-md ring-1 ring-destructive")}>
                <ComboboxAdd
                  value={ref.accepting_consultant ?? ""}
                  onChange={(v) => set("accepting_consultant", v || null)}
                  options={consultants}
                  placeholder="Select or add consultant…"
                />
              </div>
            </F>
          )}
        </Card>

        <div className="flex justify-end">
          <Button onClick={save} disabled={saving || acceptingConsultantMissing || declineConsultantMissing}><Save className="w-4 h-4 mr-1" />{saving ? "Saving…" : "Save changes"}</Button>
        </div>

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
                      // Re-run this exact edit (same body/recipients) after unlock.
                      const enc2 = await encryptForRecipients(body, recipients ?? new Set());
                      await editEncNote({ data: { id: n.id, ...enc2 } });
                      await loadNotes();
                      toast.success("Note updated");
                    })();
                    if (!ensureUnlocked(() => retry())) return;
                    if (!recipients || recipients.size === 0) {
                      toast.error("Pick at least one recipient before saving.");
                      return;
                    }
                    const enc = await encryptForRecipients(body, recipients);
                    await editEncNote({ data: { id: n.id, ...enc } });
                    await loadNotes();
                  } else {
                    const updated = await updateNoteFn({ data: { id: n.id, body } });
                    setNotes((cur) => cur.map((x) => (x.id === n.id ? { ...x, ...(updated as Note) } : x)));
                  }
                  toast.success("Note updated");
                }}
                onDelete={async () => {
                  await deleteNoteFn({ data: { id: n.id } });
                  setNotes((cur) => cur.filter((x) => x.id !== n.id));
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
            // Cancelling the unlock modal drops any queued encryption action
            // so a later confirm-missing-recipients flow can't accidentally
            // run it.
            if (!o && !e2e.isUnlocked) pendingActionRef.current = null;
          }}
          onUnlocked={async () => {
            await Promise.all([loadNotes(), loadDirectory()]);
            // If an encryption action prompted the unlock, run it now so the
            // user doesn't have to click Post/Save a second time.
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
                  // Record the explicit opt-in so future posts don't re-prompt
                  // until the missing set changes.
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



        <ReferralAuditTrail referralId={id} />




        {canDelete && (
          <div className="flex justify-end pt-2">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm">
                  <Trash2 className="w-4 h-4 mr-1" /> Delete referral
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Are you sure?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete the referral and all its notes. This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={deleting}>No, cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={onDelete} disabled={deleting} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                    {deleting ? "Deleting…" : "Yes, delete referral"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}
      </div>
    </div>
  );
}

function F({ label, children, required, error }: { label: string; children: React.ReactNode; required?: boolean; error?: string }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function ExpandableSection({ label, children, command }: { label: string; children: React.ReactNode; command?: { open: boolean; id: number } | null }) {
  const [open, setOpen] = useState(true);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => {
      setIsMobile(mq.matches);
      setOpen(!mq.matches);
    };
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (command) {
      setOpen(command.open);
    }
  }, [command?.id]);

  if (!isMobile) {
    return <F label={label}>{children}</F>;
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="space-y-1.5">
      <CollapsibleTrigger className="flex items-center justify-between w-full">
        <Label className="text-xs">{label}</Label>
        <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

function nowLocal() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function DTNow({ value, onChange, disabled, invalid }: { value: string; onChange: (v: string) => void; disabled?: boolean; invalid?: boolean }) {
  return (
    <div className={`flex gap-2 transition-opacity ${disabled ? "opacity-50" : ""}`}>
      <Input
        type="datetime-local"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={cn(
          disabled && "bg-muted border-muted-foreground/30",
          !value && "text-muted-foreground",
          invalid && !disabled && "border-destructive focus-visible:ring-destructive",
        )}
      />
      <Button type="button" variant="outline" size="sm" onClick={() => onChange(nowLocal())} disabled={disabled}>Now</Button>
    </div>
  );
}

function NoteItem({
  note,
  authorName,
  authorMap,
  directory,
  currentUserId,
  canEdit,
  onSave,
  onDelete,
}: {
  note: Note;
  authorName: string;
  authorMap: Record<string, string>;
  directory: Array<{ user_id: string; full_name: string; public_key: string | null }>;
  currentUserId?: string;
  canEdit: boolean;
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
        <NoteHistoryButton noteId={note.id} />
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
    "e2e-decrypted":     { label: "E2E encrypted", title: "End-to-end encrypted. Decrypted in your browser with your private key.", className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30", Icon: ShieldCheck },
    "e2e-locked":        { label: "E2E encrypted", title: "End-to-end encrypted. Unlock the noteboard to decrypt.", className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30", Icon: Lock },
    "e2e-no-key":        { label: "E2E encrypted", title: "End-to-end encrypted, but you were not a recipient of this note.", className: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30", Icon: ShieldAlert },
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
              <div className="flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-400 mb-1">
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
                <div className="flex items-center gap-1 font-medium text-amber-700 dark:text-amber-400 mb-1">
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


