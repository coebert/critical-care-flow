import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";

// E2E-encrypted note read/write. The server never sees the plaintext body;
// it only relays ciphertext + per-recipient sealed content keys.

const b64 = z.string().min(1).max(20000);

async function getAdmin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

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
}) {
  const admin = await getAdmin();
  await admin.from("audit_log").insert({
    user_id: entry.user_id,
    action: entry.action,
    entity: "referral_note",
    entity_id: entry.entity_id,
    // Never store plaintext or ciphertext in the audit log — the body
    // was end-to-end encrypted and is not accessible server-side.
    diff: { referral_id: entry.referral_id, body: "[e2e-encrypted]" } as any,
  } as any);
}

const wrappedKeySchema = z.object({
  recipient_user_id: z.string().uuid(),
  wrapped_key: b64,
});

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

    // ---- Server-side recipient coverage check ---------------------------
    // Even if the client thinks every teammate has a key, the directory may
    // have changed between the last check and submit. Re-verify against the
    // live public-key + clinician tables so a race can't sneak a note past
    // a teammate who just enrolled (they'd be silently excluded) OR post
    // when someone lost their key (they'd be silently unreadable to).
    const admin = await getAdmin();
    const [{ data: clinicianRows }, { data: keyRows }] = await Promise.all([
      admin
        .from("user_roles")
        .select("user_id")
        .in("role", ["admin", "clinician"]),
      admin.from("user_public_keys").select("user_id"),
    ]);



    // Delegate the rules to the pure evaluator so they can be exercised in
    // isolation by unit tests (see e2e-recipient-coverage.test.ts).
    const { evaluateRecipientCoverage } = await import("./e2e-recipient-coverage");
    const verdict = evaluateRecipientCoverage({
      authorId: userId,
      clinicianIds: (clinicianRows ?? []).map((r: any) => r.user_id as string),
      enrolledIds: (keyRows ?? []).map((r: any) => r.user_id as string),
      requestedRecipientIds: data.wrapped_keys.map((w) => w.recipient_user_id),
      allowReducedRecipients: !!data.allow_reduced_recipients,
    });

    if (!verdict.ok) {
      // Resolve names so the client toast can list teammates by name.
      const allIds = [
        ...verdict.missingNoKey,
        ...verdict.enrolledButExcluded,
        ...verdict.strayRecipients,
      ];
      const { data: profs } = allIds.length
        ? await admin.from("profiles").select("id, full_name").in("id", allIds)
        : { data: [] as Array<{ id: string; full_name: string }> };
      const nameFor = new Map<string, string>((profs ?? []).map((p: any) => [p.id, p.full_name]));
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
    // ---------------------------------------------------------------------

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

    // Replace the recipient key set.
    await supabase.from("referral_note_keys").delete().eq("note_id", data.id);
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
    if (e2) throw safeError("e2e.updateNoteKeys", e2, "Failed to update recipient keys.");

    await writeAuditE2E({
      user_id: userId,
      action: "update",
      entity_id: row.id,
      referral_id: existing.referral_id,
    });
    return row;
  });

export const listEncryptedNotes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ referral_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: rows, error } = await supabase
      .from("referral_notes")
      .select("*")
      .eq("referral_id", data.referral_id)
      .order("created_at", { ascending: true });
    if (error) throw safeError("e2e.listNotes", error, "Failed to load notes.");

    // Pull the current user's wrapped keys for the encrypted notes in this list.
    const noteIds = (rows ?? []).map((n: any) => n.id);
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
    return (rows ?? []).map((n: any) => {
      const out: any = { ...n };
      // Legacy: server-side app-layer encryption.
      if (out.body_enc && !out.body_ciphertext) {
        try {
          out.body = decryptString(out.body_enc);
        } catch {
          out.body = null;
        }
      }
      out.wrapped_key = wrappedByNote[n.id] ?? null;
      out.recipient_user_ids = recipientsByNote[n.id] ?? [];
      return out;
    });
  });
