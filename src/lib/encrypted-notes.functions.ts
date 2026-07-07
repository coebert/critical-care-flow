import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";

// E2E-encrypted note read/write. The server never sees the plaintext body;
// it only relays ciphertext + per-recipient sealed content keys.

const b64 = z.string().min(1).max(20000);

import { getAdmin } from "./server-utils";

async function fanOutForNote(userId: string, referralId: string) {
  const admin = await getAdmin();
  const [{ fanOutNotifications: runFanOut }, { buildNotificationFanoutDeps }] = await Promise.all([
    import("./notification-fanout"),
    import("./notification-fanout-deps.server"),
  ]);
  await runFanOut(
    buildNotificationFanoutDeps(admin),
    {
      actorId: userId,
      referralId,
      kind: "note",
      // Never leak note content into the notification message.
      message: "New encrypted note added to a referral",
      title: "New referral note",
    },
  );
}

async function writeAuditE2E(entry: {
  user_id: string;
  action: string;
  entity_id: string;
  referral_id?: string;
  author_id?: string;
  recipient_count?: number;
  edited_at?: string;
}) {
  const admin = await getAdmin();
  // `via_admin_flow` = the actor is editing/deleting a note they did not
  // author. The referral_notes UPDATE/DELETE policy allows this only for
  // users with the admin role, so the flag captures the admin-edit path
  // without an extra role lookup. Timestamps: audit_log.created_at is set
  // by the DB; `edited_at` is the note's own edit timestamp when relevant.
  const viaAdminFlow =
    entry.author_id !== undefined && entry.author_id !== entry.user_id;
  await admin.from("audit_log").insert({
    user_id: entry.user_id,
    action: entry.action,
    entity: "referral_note",
    entity_id: entry.entity_id,
    // Never store plaintext or ciphertext in the audit log — the body
    // was end-to-end encrypted and is not accessible server-side.
    diff: {
      referral_id: entry.referral_id,
      body: "[e2e-encrypted]",
      author_id: entry.author_id ?? null,
      via_admin_flow: viaAdminFlow,
      recipient_count: entry.recipient_count ?? null,
      edited_at: entry.edited_at ?? null,
    } as any,
  } as any);
}

const wrappedKeySchema = z.object({
  recipient_user_id: z.string().uuid(),
  wrapped_key: b64,
});

/**
 * Server-side re-check of recipient coverage. The client caches the
 * public-key directory; between that cache and the server insert, teammates
 * may have enrolled (silently excluded) or lost keys (silently unreadable).
 * Both `addEncryptedNote` and `updateEncryptedNote` must call this so an
 * edit can't drop colleagues either.
 */
async function assertRecipientCoverage(params: {
  authorId: string;
  requestedRecipientIds: string[];
  allowReducedRecipients: boolean;
}) {
  const admin = await getAdmin();
  const [{ data: clinicianRows }, { data: keyRows }] = await Promise.all([
    admin.from("user_roles").select("user_id").in("role", ["admin", "clinician"]),
    admin.from("user_public_keys").select("user_id"),
  ]);
  const { evaluateRecipientCoverage } = await import("./e2e-recipient-coverage");
  const verdict = evaluateRecipientCoverage({
    authorId: params.authorId,
    clinicianIds: (clinicianRows ?? []).map((r: any) => r.user_id as string),
    enrolledIds: (keyRows ?? []).map((r: any) => r.user_id as string),
    requestedRecipientIds: params.requestedRecipientIds,
    allowReducedRecipients: params.allowReducedRecipients,
  });
  if (verdict.ok) return;

  const allIds = [
    ...verdict.missingNoKey,
    ...verdict.enrolledButExcluded,
    ...verdict.strayRecipients,
  ];
  const { data: profs } = allIds.length
    ? await admin.from("profiles").select("id, full_name").in("id", allIds)
    : { data: [] as Array<{ id: string; full_name: string }> };
  const nameFor = new Map<string, string>(
    (profs ?? []).map((p: any) => [p.id, p.full_name]),
  );
  const decorate = (ids: string[]) =>
    ids.map((id) => ({ user_id: id, full_name: nameFor.get(id) ?? "Unknown teammate" }));
  const payload = {
    code: verdict.reason,
    missing_no_key: decorate(verdict.missingNoKey),
    enrolled_but_excluded: decorate(verdict.enrolledButExcluded),
    stray_recipients: decorate(verdict.strayRecipients),
  };
  throw new Error(`RECIPIENT_COVERAGE_CHANGED::${JSON.stringify(payload)}`);
}

export const addEncryptedNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        referral_id: z.string().uuid(),
        body_ciphertext: b64,
        body_nonce: b64,
        enc_version: z.number().int().min(1).max(255),
        wrapped_keys: z.array(wrappedKeySchema).min(1).max(500),
        // Explicit acknowledgement that the author is knowingly posting to a
        // reduced recipient set (some enrolled teammates excluded, or some
        // clinicians without a published key). The client must set this
        // after the user confirms the "post to reduced set" dialog.
        allow_reduced_recipients: z.boolean().optional().default(false),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    await assertRecipientCoverage({
      authorId: userId,
      requestedRecipientIds: data.wrapped_keys.map((w) => w.recipient_user_id),
      allowReducedRecipients: !!data.allow_reduced_recipients,
    });

    // Insert the note (no plaintext, no body_enc — pure ciphertext).
    const { data: row, error } = await supabase
      .from("referral_notes")
      .insert({
        referral_id: data.referral_id,
        author_id: userId,
        body: null,
        body_enc: null,
        body_ciphertext: data.body_ciphertext,
        body_nonce: data.body_nonce,
        enc_version: data.enc_version,
      } as any)
      .select()
      .single();
    if (error) throw safeError("e2e.addNote", error, "Failed to add note.");

    // Insert one wrapped-key row per recipient. Filter out duplicates.
    const seen = new Set<string>();
    const wrappedRows = data.wrapped_keys
      .filter((w) => (seen.has(w.recipient_user_id) ? false : seen.add(w.recipient_user_id)))
      .map((w) => ({
        note_id: row.id,
        recipient_user_id: w.recipient_user_id,
        wrapped_key: w.wrapped_key,
      }));
    const { error: e2 } = await supabase
      .from("referral_note_keys")
      .insert(wrappedRows as any);
    if (e2) {
      // Roll back the note so we never have an unreadable orphan.
      await supabase.from("referral_notes").delete().eq("id", row.id);
      throw safeError("e2e.addNoteKeys", e2, "Failed to store recipient keys.");
    }

    await writeAuditE2E({
      user_id: userId,
      action: "create",
      entity_id: row.id,
      referral_id: data.referral_id,
      author_id: userId,
      recipient_count: wrappedRows.length,
    });
    await fanOutForNote(userId, data.referral_id);
    return row;
  });

export const updateEncryptedNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        body_ciphertext: b64,
        body_nonce: b64,
        enc_version: z.number().int().min(1).max(255),
        wrapped_keys: z.array(wrappedKeySchema).min(1).max(500),
        allow_reduced_recipients: z.boolean().optional().default(false),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: existing } = await supabase
      .from("referral_notes")
      .select("id, referral_id, author_id")
      .eq("id", data.id)
      .maybeSingle();
    if (!existing) throw new Error("Note not found");

    // Same server-side coverage check as add — edits must not silently drop
    // colleagues or exclude teammates who enrolled between the client's
    // directory cache and this submit.
    await assertRecipientCoverage({
      authorId: userId,
      requestedRecipientIds: data.wrapped_keys.map((w) => w.recipient_user_id),
      allowReducedRecipients: !!data.allow_reduced_recipients,
    });

    const { data: row, error } = await supabase
      .from("referral_notes")
      .update({
        body: null,
        body_enc: null,
        body_ciphertext: data.body_ciphertext,
        body_nonce: data.body_nonce,
        enc_version: data.enc_version,
        edited_at: new Date().toISOString(),
      } as any)
      .eq("id", data.id)
      .select()
      .single();
    if (error) throw safeError("e2e.updateNote", error, "Failed to update note.");

    // Replace the recipient key set. Snapshot the existing keys first so we
    // can restore them if the re-insert fails — a naked delete+insert leaves
    // the note permanently unreadable (updated ciphertext, zero wrapped keys).
    const { data: oldKeys, error: fetchErr } = await supabase
      .from("referral_note_keys")
      .select("note_id, recipient_user_id, wrapped_key")
      .eq("note_id", data.id);
    if (fetchErr) throw safeError("e2e.updateNoteKeys.snapshot", fetchErr, "Failed to snapshot existing keys.");

    const { error: delErr } = await supabase
      .from("referral_note_keys")
      .delete()
      .eq("note_id", data.id);
    if (delErr) throw safeError("e2e.updateNoteKeys.delete", delErr, "Failed to clear existing keys.");

    const seen = new Set<string>();
    const wrappedRows = data.wrapped_keys
      .filter((w) => (seen.has(w.recipient_user_id) ? false : seen.add(w.recipient_user_id)))
      .map((w) => ({
        note_id: data.id,
        recipient_user_id: w.recipient_user_id,
        wrapped_key: w.wrapped_key,
      }));
    const { error: e2 } = await supabase
      .from("referral_note_keys")
      .insert(wrappedRows as any);
    if (e2) {
      // Restore the previous key set so the note remains readable to its
      // original recipients. If this also fails, log both — the note body
      // was still updated and we surface the original failure to the caller.
      if (oldKeys && oldKeys.length) {
        const { error: restoreErr } = await supabase
          .from("referral_note_keys")
          .insert(oldKeys as any);
        if (restoreErr) {
          console.error("e2e.updateNoteKeys.restore FAILED", restoreErr, "originalError=", e2);
        }
      }
      throw safeError("e2e.updateNoteKeys", e2, "Failed to update recipient keys.");
    }

    await writeAuditE2E({
      user_id: userId,
      action: "update",
      entity_id: row.id,
      referral_id: existing.referral_id,
      author_id: existing.author_id,
      recipient_count: wrappedRows.length,
      edited_at: (row as any).edited_at ?? null,
    });
    return row;
  });

export const listEncryptedNotes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ referral_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Cap the number of notes we hydrate wrapped keys for. Each note can
    // have up to ~500 recipient rows, so an unbounded `IN (...)` on
    // referral_note_keys could scan tens of thousands of rows for a busy
    // referral. Show the most recent NOTE_HYDRATE_CAP notes and log if we
    // hit the cap so we know to add windowed paging.
    const NOTE_HYDRATE_CAP = 50;
    const { data: rows, error } = await supabase
      .from("referral_notes")
      .select("*")
      .eq("referral_id", data.referral_id)
      .order("created_at", { ascending: true });
    if (error) throw safeError("e2e.listNotes", error, "Failed to load notes.");

    const allRows = rows ?? [];
    // Keep the most recent N; if we hit the cap, warn once per call.
    const hydrateRows =
      allRows.length > NOTE_HYDRATE_CAP
        ? allRows.slice(allRows.length - NOTE_HYDRATE_CAP)
        : allRows;
    if (allRows.length > NOTE_HYDRATE_CAP) {
      console.warn(
        `[e2e.listNotes] referral ${data.referral_id} has ${allRows.length} notes; hydrating latest ${NOTE_HYDRATE_CAP}`,
      );
    }

    const noteIds = hydrateRows.map((n: any) => n.id);
    const hydratedIds = new Set(noteIds);
    let wrappedByNote: Record<string, string> = {};
    let recipientsByNote: Record<string, string[]> = {};
    if (noteIds.length) {
      const { data: keys } = await supabase
        .from("referral_note_keys")
        .select("note_id, wrapped_key")
        .in("note_id", noteIds)
        .eq("recipient_user_id", userId);
      wrappedByNote = Object.fromEntries(
        (keys ?? []).map((k: any) => [k.note_id, k.wrapped_key]),
      );

      // Fetch full recipient list per note via admin so authors and other
      // recipients can see who a note was addressed to. Recipient identity
      // is not more sensitive than the notification fanout already implies.
      const admin = await getAdmin();
      const { data: allKeys } = await admin
        .from("referral_note_keys")
        .select("note_id, recipient_user_id")
        .in("note_id", noteIds);
      for (const k of (allKeys ?? []) as any[]) {
        (recipientsByNote[k.note_id] ??= []).push(k.recipient_user_id);
      }
    }

    // Legacy plaintext / body_enc notes are still relayed for backward
    // compatibility. The client decides how to render each.
    const { decryptString } = await import("./crypto.server");
    return allRows.map((n: any) => {
      const out: any = { ...n };
      // Legacy: server-side app-layer encryption.
      if (out.body_enc && !out.body_ciphertext) {
        try {
          out.body = decryptString(out.body_enc);
        } catch {
          out.body = null;
        }
      }
      // For notes older than the hydration window, flag that keys weren't
      // fetched so the client can render a "load older notes" affordance
      // rather than treat them as decryption failures.
      const wasHydrated = hydratedIds.has(n.id);
      out.wrapped_key = wasHydrated ? (wrappedByNote[n.id] ?? null) : null;
      out.recipient_user_ids = wasHydrated ? (recipientsByNote[n.id] ?? []) : [];
      out.keys_not_hydrated = !wasHydrated;
      return out;
    });
  });
