import { createServerFn } from "@tanstack/react-start";
import { safeError } from "./safe-error";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { encryptString, decryptString, hashHospitalNumber } from "./crypto.server";
import { decideReferralRestore, decideReferralUpdate } from "./referral-restore-authz";
import type { Database, Tables } from "@/integrations/supabase/types";

const refSchema = z.object({
  age: z.number().int().min(0).max(130).nullable().optional(),
  sex: z.enum(["male", "female", "other", "unknown"]).nullable().optional(),
  hospital_number: z.string().trim().max(50).nullable().optional(),
  current_ward: z.string().trim().max(100).nullable().optional(),
  current_bed: z.string().trim().max(50).nullable().optional(),
  past_medical_history: z.string().trim().max(5000).nullable().optional(),
  baseline_function: z.string().trim().max(2000).nullable().optional(),
  dnacpr_respect: z.boolean().optional(),
  consultant_to_consultant_only: z.boolean().optional(),
  referring_specialty: z.string().trim().max(100).nullable().optional(),
  reason_for_referral: z.string().trim().max(5000).nullable().optional(),
  referral_received_at: z.string().optional(),
  first_seen_at: z.string().nullable().optional(),
  decision_at: z.string().nullable().optional(),
  arrived_on_unit_at: z.string().nullable().optional(),
  status: z.enum(["pending", "accepted", "declined", "admitted"]).optional(),
  decline_reason: z.string().trim().max(2000).nullable().optional(),
  discussed_with_consultant: z.string().trim().max(120).nullable().optional(),
  accepting_consultant: z.string().trim().max(120).nullable().optional(),
  admission_urgency: z
    .enum(["within_15_min", "within_30_min", "within_1_hour", "within_1_2_hours", "not_admitting"])
    .nullable()
    .optional(),
  // Flags a referral entered for testing/demonstration only. Rows with
  // is_test=true are excluded from analytics dashboards.
  is_test: z.boolean().optional(),

  // ---- Point-2 clinical fields ----
  news2_score: z.number().int().min(0).max(20).nullable().optional(),
  news2_recorded_at: z.string().nullable().optional(),
  ceiling_of_care: z
    .enum(["full_escalation", "no_cpr", "ward_based", "symptom_control", "not_documented"])
    .nullable()
    .optional(),
  reason_category: z
    .enum([
      "respiratory_failure", "sepsis", "shock", "post_op",
      "neurology", "trauma", "gi_bleed", "metabolic", "overdose", "other",
    ])
    .nullable()
    .optional(),
  frailty_score: z.number().int().min(1).max(9).nullable().optional(),
  anticipated_interventions: z
    .array(
      z.enum([
        "invasive_ventilation", "niv_cpap", "hfno", "vasopressors",
        "rrt", "neuro_obs", "arterial_line", "central_line", "other",
      ]),
    )
    .optional(),
  infection_status: z.enum(["none", "suspected", "confirmed", "unknown"]).nullable().optional(),
  infection_organism: z.string().trim().max(200).nullable().optional(),
  weight_kg: z.number().positive().max(400).nullable().optional(),
  allergies: z.string().trim().max(1000).nullable().optional(),
  resus_status: z.enum(["for_cpr", "dnacpr", "not_documented"]).nullable().optional(),
  previous_referral_id: z.string().uuid().nullable().optional(),
  outcome: z.enum(["admit_for_admission", "review_on_ward", "advice_given", "declined"]).nullable().optional(),
  outcome_recorded_at: z.string().nullable().optional(),

  // Ongoing-review flags — set by critical care when a patient should be
  // followed up on the ward or kept on the CCOT review list.
  needs_ward_review: z.boolean().optional(),
  for_ongoing_ccot_review: z.boolean().optional(),
  ward_review_timeframe: z
    .enum(["12h", "24h", "48h", "72h", "weekly", "prn"])
    .nullable()
    .optional(),
});


import { getAdmin } from "./server-utils";

// ---------------------------------------------------------------------------
// Encryption mapping helpers
// ---------------------------------------------------------------------------
// These fields are stored encrypted in *_enc columns. The original
// plaintext columns no longer exist in the database — every write
// must encrypt and every read must decrypt. `hospital_number` is
// additionally hashed (HMAC-SHA256) into `hospital_number_hash` so
// repeat-patient lookups still work without ever storing plaintext.

const ENCRYPTED_TEXT_FIELDS = [
  "past_medical_history",
  "baseline_function",
  "reason_for_referral",
  "hospital_number",
] as const;

type EncryptedField = (typeof ENCRYPTED_TEXT_FIELDS)[number];

// Row shape returned by list/detail server fns: the underlying
// `Tables<"referrals">` row (including the `*_enc` ciphertext columns)
// with the plaintext values decrypted back onto their original field
// names so the UI can consume them without knowing about encryption.
export type DecryptedReferral = Tables<"referrals"> & {
  hospital_number: string | null;
  past_medical_history: string | null;
  baseline_function: string | null;
  reason_for_referral: string | null;
  /** Names of encrypted fields that failed to decrypt for this row, if any. */
  _decryption_failed_fields?: string[];
  /** Display name of the clinician who created this referral, joined in
   *  server-side to avoid a client-side N+1 profile lookup. */
  creator_name?: string | null;
};

export type DecryptedReferralNote = Tables<"referral_notes"> & {
  body: string | null;
};

function applyEncryption(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  // Compute hash BEFORE the encryption loop nulls the plaintext key.
  if ("hospital_number" in out) {
    const hn = out.hospital_number;
    out.hospital_number_hash = hashHospitalNumber(hn == null ? null : String(hn));
  }
  for (const k of ENCRYPTED_TEXT_FIELDS) {
    if (k in out) {
      const plain = out[k];
      out[`${k}_enc`] = encryptString(plain == null ? null : String(plain));
      // Plaintext columns have been dropped — strip the key entirely.
      delete out[k];
    }
  }
  return out;
}

function decryptReferralRow<T extends Record<string, any>>(row: T): T & DecryptedReferral {
  if (!row) return row as T & DecryptedReferral;
  const out: any = { ...row };
  const failed: string[] = [];
  for (const k of ENCRYPTED_TEXT_FIELDS) {
    const enc = out[`${k}_enc`] as string | null | undefined;
    if (enc) {
      try {
        out[k] = decryptString(enc);
      } catch (err) {
        // A single poisoned/rotated row must not blank out the whole list,
        // but silently returning null hides the failure from the UI so
        // clinicians can't tell "no data" from "we couldn't decrypt".
        // Signal per-field so callers can render a "decryption failed"
        // marker, and log once server-side for ops visibility.
        out[k] = null;
        failed.push(k);
        console.warn(`[referrals.decrypt] field ${k} failed to decrypt on row ${out.id ?? "?"}:`, (err as Error)?.message);
      }
    } else {
      out[k] = null;
    }
  }
  if (failed.length > 0) {
    out._decryption_failed_fields = failed;
  }
  return out as T & DecryptedReferral;
}

// Audit diffs must not contain plaintext for encrypted fields, otherwise
// a DB leak of audit_log would reveal what the referral columns hide.
function redactEncryptedFromDiff(diff: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...diff };
  for (const k of ENCRYPTED_TEXT_FIELDS) {
    if (k in out && out[k] != null && out[k] !== "") {
      out[k] = "[encrypted]";
    }
    // Strip the ciphertext too — there is no point storing it twice.
    delete out[`${k}_enc`];
  }
  delete (out as any).hospital_number_hash;
  return out;
}


async function writeAudit(entry: {
  user_id: string;
  action: string;
  entity: string;
  entity_id: string;
  diff?: any;
  // Optional full-context fields for referral_note audit rows. Passed at every
  // note create/edit/delete site so the audit stream carries actor identity,
  // original author identity, recipient count, and edit timestamp — plus a
  // derived via_admin_flag flag = actor !== author.
  referral_id?: string;
  author_id?: string | null;
  recipient_count?: number | null;
  edited_at?: string | null;
}) {
  const admin = await getAdmin();
  let workingDiff = entry.diff;
  if (entry.entity === "referral" && workingDiff && typeof workingDiff === "object") {
    workingDiff = redactEncryptedFromDiff(workingDiff as Record<string, unknown>);
  } else if (entry.entity === "referral_note" && workingDiff && typeof workingDiff === "object") {
    workingDiff = redactNoteDiff(workingDiff as Record<string, unknown>);
  }
  if (entry.entity === "referral_note") {
    const { computeViaAdminFlow } = await import("./encrypted-notes.functions");
    const authorId = entry.author_id ?? null;
    workingDiff = {
      ...(workingDiff && typeof workingDiff === "object" ? workingDiff : {}),
      actor_id: entry.user_id,
      author_id: authorId,
      via_admin_flow: computeViaAdminFlow(entry.user_id, authorId),
      referral_id:
        entry.referral_id ??
        (workingDiff && typeof workingDiff === "object" ? (workingDiff as any).referral_id : undefined) ??
        null,
      recipient_count: entry.recipient_count ?? null,
      edited_at: entry.edited_at ?? null,
    };
  }
  await admin.from("audit_log").insert({
    user_id: entry.user_id,
    action: entry.action,
    entity: entry.entity,
    entity_id: entry.entity_id,
    diff: workingDiff,
  } as any);
}


function redactNoteDiff(diff: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...diff };
  if ("body" in out && out.body != null && out.body !== "") out.body = "[encrypted]";
  if (out.before && typeof out.before === "object") {
    out.before = { ...(out.before as any), body: "[encrypted]" };
  }
  if (out.after && typeof out.after === "object") {
    out.after = { ...(out.after as any), body: "[encrypted]" };
  }
  delete (out as any).body_enc;
  return out;
}

async function fanOutNotifications(
  userId: string,
  referralId: string,
  kind: "new" | "updated" | "status" | "note",
  message: string,
  url?: string,
  title?: string,
) {
  const admin = await getAdmin();
  const [{ fanOutNotifications: runFanOut }, { buildNotificationFanoutDeps }] = await Promise.all([
    import("./notification-fanout"),
    import("./notification-fanout-deps.server"),
  ]);
  await runFanOut(
    buildNotificationFanoutDeps(admin),
    { actorId: userId, referralId, kind, message, url, title },
  );
}


/**
 * Server-side defence-in-depth: verify the calling user is an active
 * member of the critical care team ('admin' or 'clinician' role) before
 * touching any referral surface. RLS also enforces this via
 * `public.has_clinical_access(uuid)`, but relying on RLS alone means a
 * non-clinical user gets silent empty lists on reads and cryptic
 * "row violates row-level security" errors on writes. Calling this
 * helper first turns those into a clear 403 that the UI can surface.
 *
 * Throws an Error whose message we deliberately mirror as
 * "Forbidden: clinical access required" everywhere so log analysis and
 * UI messaging stay consistent.
 */
async function assertClinicalAccess(
  supabase: import("@supabase/supabase-js").SupabaseClient<Database>,
  userId: string,
): Promise<void> {
  const { data, error } = await supabase.rpc("has_clinical_access", { _user_id: userId });
  if (error) throw safeError("referrals.authz", error, "Permission check failed.");
  if (!data) throw new Error("Forbidden: clinical access required");
}


export const createReferral = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => refSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertClinicalAccess(supabase, userId);
    const { validateReferralAll } = await import("./referral-validation");
    const gateCheck = validateReferralAll({
      status: data.status ?? "pending",
      referral_received_at: data.referral_received_at ?? new Date().toISOString(),
      first_seen_at: data.first_seen_at ?? null,
      decision_at: data.decision_at ?? null,
      arrived_on_unit_at: data.arrived_on_unit_at ?? null,
      decline_reason: data.decline_reason ?? null,
      discussed_with_consultant: data.discussed_with_consultant ?? null,
      accepting_consultant: data.accepting_consultant ?? null,
      admission_urgency: data.admission_urgency ?? null,
    });
    if (!gateCheck.isValid) {
      const first = Object.values(gateCheck.fieldErrors)[0] ?? gateCheck.issues[0];
      throw new Error(first ?? "Referral data failed validation.");
    }

    const baseInsert = applyEncryption({
      ...data,
      created_by: userId,
      updated_by: userId,
      referral_received_at: data.referral_received_at ?? new Date().toISOString(),
    });
    const { data: row, error } = await supabase
      .from("referrals")
      .insert(baseInsert as any)
      .select()
      .single();
    if (error) throw safeError("referrals.create", error, "Failed to create referral.");

    const decrypted = decryptReferralRow(row as any);

    await writeAudit({
      user_id: userId,
      action: "create",
      entity: "referral",
      entity_id: row.id,
      diff: { ...(data as any) },
    });

    const summary = `${decrypted.referring_specialty ?? "Referral"} — ${decrypted.current_ward ?? "ward unknown"}`;
    await fanOutNotifications(userId, row.id, "new", `New referral: ${summary}`);

    // If this patient has a prior DECLINED referral on record, flag it loudly.
    // We match by the new hash column so the lookup keeps working even when
    // the plaintext hospital_number column is dropped.
    const hashed = hashHospitalNumber((data as any).hospital_number);
    if (hashed) {
      const admin = await getAdmin();
      const { data: priorDeclined } = await admin
        .from("referrals")
        .select("id, decision_at, referral_received_at, decline_reason")
        .eq("hospital_number_hash", hashed)
        .eq("status", "declined")
        .is("deleted_at", null)
        .neq("id", row.id)
        .order("referral_received_at", { ascending: false })
        .limit(1);
      if (priorDeclined && priorDeclined.length > 0) {
        const prev = priorDeclined[0];
        const when = prev.decision_at ?? prev.referral_received_at;
        const whenStr = when ? new Date(when).toLocaleDateString("en-GB") : "previously";
        const reasonRaw = (prev.decline_reason ?? "").trim();
        const reason = reasonRaw.length > 200 ? `${reasonRaw.slice(0, 197)}…` : reasonRaw;
        const reasonStr = reason ? ` Reason: ${reason}` : " Reason not recorded.";
        await fanOutNotifications(
          userId,
          row.id,
          "updated",
          `⚠️ Patient has a previously DECLINED critical care referral (${whenStr}).${reasonStr} — ${summary}`,
          `/referrals/${prev.id}?highlight=declined`,
        );
      }
    }
    return decrypted;
  });



export const updateReferral = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), patch: refSchema }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertClinicalAccess(supabase, userId);
    const { data: prior } = await supabase
      .from("referrals")
      .select(
        "status, decline_reason, accepting_consultant, discussed_with_consultant, admission_urgency, referral_received_at, first_seen_at, decision_at, arrived_on_unit_at, created_by, deleted_at",
      )
      .eq("id", data.id)
      .maybeSingle();

    // Defence-in-depth: RLS already blocks non-creator/non-admin writes to
    // soft-deleted rows, but we mirror the rule here so the server returns a
    // clear error instead of a silent no-op update.
    const { data: isAdmin } = await supabase.rpc("has_role", {
      _user_id: userId,
      _role: "admin",
    });
    const gate = decideReferralUpdate({
      row: prior ? { created_by: (prior as any).created_by ?? null, deleted_at: (prior as any).deleted_at ?? null } : null,
      userId,
      isAdmin: !!isAdmin,
    });
    if (gate.kind === "forbidden_soft_deleted") {
      throw new Error("Only the creator or an admin can restore this referral");
    }

    const pickPatched = <K extends keyof typeof data.patch>(k: K) =>
      (data.patch as any)[k] !== undefined ? (data.patch as any)[k] : (prior as any)?.[k];

    const { validateReferralAll } = await import("./referral-validation");
    const updateCheck = validateReferralAll({
      status: pickPatched("status") ?? "pending",
      referral_received_at: pickPatched("referral_received_at") ?? null,
      first_seen_at: pickPatched("first_seen_at") ?? null,
      decision_at: pickPatched("decision_at") ?? null,
      arrived_on_unit_at: pickPatched("arrived_on_unit_at") ?? null,
      decline_reason: pickPatched("decline_reason") ?? null,
      discussed_with_consultant: pickPatched("discussed_with_consultant") ?? null,
      accepting_consultant: pickPatched("accepting_consultant") ?? null,
      admission_urgency: pickPatched("admission_urgency") ?? null,
    }, { ignorePastCap: true });
    if (!updateCheck.isValid) {
      const first = Object.values(updateCheck.fieldErrors)[0] ?? updateCheck.issues[0];
      throw new Error(first ?? "Referral data failed validation.");
    }


    const patchEncrypted = applyEncryption({ ...data.patch, updated_by: userId });

    const { data: row, error } = await supabase
      .from("referrals")
      .update(patchEncrypted as any)
      .eq("id", data.id)
      .select()
      .single();
    if (error) throw safeError("referrals.update", error, "Failed to update referral.");

    await writeAudit({
      user_id: userId,
      action: "update",
      entity: "referral",
      entity_id: row.id,
      diff: { ...(data.patch as any) },
    });

    const decrypted = decryptReferralRow(row as any);

    const statusChanged =
      data.patch.status !== undefined && prior?.status !== row.status;
    if (statusChanged) {
      const summary = `${decrypted.referring_specialty ?? "Referral"} — ${decrypted.current_ward ?? "ward unknown"}`;
      const statusLabel = String(row.status ?? "updated").toUpperCase();
      await fanOutNotifications(
        userId,
        row.id,
        "status",
        `Status → ${statusLabel}: ${summary}`,
        undefined,
        `Referral ${statusLabel}`,
      );
    }
    return decrypted;
  });


// ---------------------------------------------------------------------------
// Read paths: clients fetch referrals through these so the server can
// decrypt before sending. Realtime channels on the client deliver
// ciphertext payloads and should be used only as a refetch trigger.
// ---------------------------------------------------------------------------

// Cap for the live-referrals list. The dashboard is realtime-driven (any
// insert/update/delete triggers a full refetch), which rules out cursor-style
// pagination without redesigning the sync model. In real use the number of
// non-deleted referrals in flight sits well under this cap; we log a warning
// if we ever hit it so we know when to migrate to a paged/windowed feed.
const REFERRALS_LIST_HARD_CAP = 500;

export const listReferralsForList = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<DecryptedReferral[]> => {
    const { supabase, userId } = context;
    await assertClinicalAccess(supabase, userId);
    const { data, error } = await supabase
      .from("referrals")
      .select("*")
      .is("deleted_at", null)
      .order("referral_received_at", { ascending: false })
      .limit(REFERRALS_LIST_HARD_CAP);
    if (error) throw safeError("referrals.list", error, "Failed to load referrals.");
    if ((data?.length ?? 0) >= REFERRALS_LIST_HARD_CAP) {
      console.warn(
        `[referrals.list] hit hard cap of ${REFERRALS_LIST_HARD_CAP} live rows — ` +
          `results are truncated. Add pagination before the active queue can exceed this.`,
      );
    }
    const rows = (data ?? []).map((r) => decryptReferralRow(r as any));

    // Join clinician display names server-side to avoid a client-side N+1
    // profile lookup for the "Taken by" column. RLS on profiles already
    // permits authenticated users to read names.
    const creatorIds = Array.from(
      new Set(rows.map((r) => r.created_by).filter((id): id is string => !!id)),
    );
    if (creatorIds.length) {
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, full_name")
        .in("id", creatorIds);
      const nameById = new Map<string, string | null>(
        (profs ?? []).map((p) => [p.id, p.full_name ?? null]),
      );
      for (const r of rows) {
        r.creator_name = r.created_by ? nameById.get(r.created_by) ?? null : null;
      }
    }

    return rows;
  });


export const getReferralDetail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertClinicalAccess(supabase, userId);
    const { data: row, error } = await supabase
      .from("referrals")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw safeError("referrals.get", error, "Failed to load referral.");
    if (!row) return null;
    return decryptReferralRow(row as any);
  });

export const listReferralNotesDecrypted = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ referral_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertClinicalAccess(supabase, userId);
    const { data: rows, error } = await supabase
      .from("referral_notes")
      .select("*")
      .eq("referral_id", data.referral_id)
      .order("created_at", { ascending: true });
    if (error) throw safeError("referrals.listNotes", error, "Failed to load notes.");
    return (rows ?? []).map((n: any) => {
      const out = { ...n };
      if (out.body_enc) {
        try {
          out.body = decryptString(out.body_enc);
        } catch {
          out.body = null;
        }
      }
      return out;
    });
  });


/**
 * E2E-by-default enforcement.
 *
 * `addNote` and `updateNote` write server-side-encrypted (`body_enc`) rows
 * — the pre-E2E note storage path. End-to-end encryption is the default
 * for every new note in this app, so both server functions are hard-gated
 * behind `ALLOW_NON_E2E_NOTES=true`. When that env flag is not set (the
 * default), calling either function throws so no client can silently fall
 * back to non-E2E storage. Compose flows use the E2E path in
 * `encrypted-notes.functions.ts` instead.
 */
const NON_E2E_NOTES_ENABLED = process.env.ALLOW_NON_E2E_NOTES === "true";
function assertNonE2EWritesAllowed(op: "add" | "update") {
  if (NON_E2E_NOTES_ENABLED) return;
  throw new Error(
    `End-to-end encryption is required for notes (${op}). ` +
      "Use the encrypted-notes flow, or set ALLOW_NON_E2E_NOTES=true to " +
      "explicitly opt out.",
  );
}

export const addNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({ referral_id: z.string().uuid(), body: z.string().trim().min(1).max(2000) })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    assertNonE2EWritesAllowed("add");
    const { supabase, userId } = context;
    await assertClinicalAccess(supabase, userId);
    const { data: row, error } = await supabase
      .from("referral_notes")
      .insert({
        referral_id: data.referral_id,
        author_id: userId,
        body: null,
        body_enc: encryptString(data.body),
      } as any)
      .select()
      .single();
    if (error) throw safeError("referrals.addNote", error, "Failed to add note.");

    await writeAudit({
      user_id: userId,
      action: "create",
      entity: "referral_note",
      entity_id: row.id,
      referral_id: data.referral_id,
      author_id: userId,
      recipient_count: 0,
      edited_at: null,
      diff: { referral_id: data.referral_id, body: data.body },
    });


    await fanOutNotifications(
      userId,
      data.referral_id,
      "note",
      `New note added to referral`,
      undefined,
      "New referral note",
    );
    return { ...row, body: data.body };
  });


export const updateNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({ id: z.string().uuid(), body: z.string().trim().min(1).max(2000) })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    assertNonE2EWritesAllowed("update");
    const { supabase, userId } = context;
    await assertClinicalAccess(supabase, userId);
    const { data: existing } = await supabase
      .from("referral_notes")
      .select("id, body_enc, referral_id, author_id")
      .eq("id", data.id)
      .maybeSingle();
    if (!existing) throw new Error("Note not found");

    const { data: row, error } = await supabase
      .from("referral_notes")
      .update({
        body: null,
        body_enc: encryptString(data.body),
        edited_at: new Date().toISOString(),
      } as any)
      .eq("id", data.id)
      .select()
      .single();
    if (error) throw safeError("referrals.updateNote", error, "Failed to update note.");

    let beforeBody: string | null = (existing as any).body ?? null;
    const beforeEnc = (existing as any).body_enc as string | null | undefined;
    if (beforeEnc) {
      try { beforeBody = decryptString(beforeEnc); } catch { beforeBody = null; }
    }

    await writeAudit({
      user_id: userId,
      action: "update",
      entity: "referral_note",
      entity_id: row.id,
      referral_id: existing.referral_id,
      author_id: (existing as any).author_id ?? null,
      recipient_count: 0,
      edited_at: (row as any).edited_at ?? null,
      diff: {
        referral_id: existing.referral_id,
        before: { body: beforeBody },
        after: { body: data.body },
      },
    });

    return { ...row, body: data.body };
  });


export const deleteNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: existing } = await supabase
      .from("referral_notes")
      .select("id, body_enc, referral_id, author_id, created_at")
      .eq("id", data.id)
      .maybeSingle();
    if (!existing) throw new Error("Note not found");

    // Only the note author or an admin may delete. RLS should also enforce
    // this, but the server checks explicitly so we never rely on a single
    // gate — and so we return a clear error instead of a silent no-op if
    // the policy is ever loosened.
    if (existing.author_id !== userId) {
      const { data: isAdmin, error: roleErr } = await supabase.rpc("has_role", {
        _user_id: userId,
        _role: "admin",
      });
      if (roleErr) throw safeError("referrals.deleteNote.role", roleErr, "Permission check failed.");
      if (!isAdmin) throw new Error("Forbidden: only the note author or an admin can delete this note.");
    }

    // Count wrapped-key recipients before deletion so the audit record
    // preserves the fanout size (rows cascade or are removed with the note).
    const admin = await getAdmin();
    const { count: recipientCount } = await admin
      .from("referral_note_keys")
      .select("recipient_user_id", { count: "exact", head: true })
      .eq("note_id", data.id);

    const { error } = await supabase.from("referral_notes").delete().eq("id", data.id);
    if (error) throw safeError("referrals.deleteNote", error, "Failed to delete note.");

    await writeAudit({
      user_id: userId,
      action: "delete",
      entity: "referral_note",
      entity_id: data.id,
      referral_id: (existing as any).referral_id ?? null,
      author_id: (existing as any).author_id ?? null,
      recipient_count: recipientCount ?? 0,
      edited_at: (existing as any).edited_at ?? null,
      diff: existing as any,
    });
    return { ok: true };
  });



export const getNoteHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ note_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: access } = await supabase.rpc("has_clinical_access", { _user_id: userId });
    if (!access) throw new Error("Forbidden");

    const admin = await getAdmin();
    const { data: rows, error } = await admin
      .from("audit_log")
      .select("id, user_id, action, diff, created_at")
      .eq("entity", "referral_note")
      .eq("entity_id", data.note_id)
      .order("created_at", { ascending: false });
    if (error) throw safeError("referrals.getNoteHistory", error, "Failed to load note history.");

    const userIds = Array.from(new Set((rows ?? []).map((r: any) => r.user_id).filter(Boolean)));
    let names: Record<string, string> = {};
    if (userIds.length) {
      const { data: profs } = await admin
        .from("profiles")
        .select("id, full_name")
        .in("id", userIds as string[]);
      profs?.forEach((p: any) => { names[p.id] = p.full_name ?? "Clinician"; });
    }
    return (rows ?? []).map((r: any) => ({
      id: r.id,
      action: r.action,
      created_at: r.created_at,
      user_id: r.user_id,
      user_name: names[r.user_id] ?? "Clinician",
      diff: r.diff,
    }));
  });


// Fields shown in the referral audit trail. Other columns (created_by,
// updated_by, deleted_*) are bookkeeping and excluded from the diff view.
const AUDITED_REFERRAL_FIELDS = [
  "age", "sex", "hospital_number", "current_ward", "current_bed",
  "past_medical_history", "baseline_function", "dnacpr_respect",
  "consultant_to_consultant_only",
  "referring_specialty", "reason_for_referral",
  "referral_received_at", "first_seen_at", "decision_at", "arrived_on_unit_at",
  "status", "decline_reason", "discussed_with_consultant", "accepting_consultant", "admission_urgency",
] as const;

export type AuditValue = string | number | boolean | null;

export type ReferralAuditEntry = {
  id: string;
  action: string;
  created_at: string;
  user_id: string | null;
  user_name: string;
  changes: { field: string; from: AuditValue; to: AuditValue }[];
  snapshot?: Record<string, AuditValue>;
};

export type ReferralAuditPage = {
  entries: ReferralAuditEntry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
};

const HISTORY_PAGE_MAX = 100;

export const getReferralHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        referral_id: z.string().uuid(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(HISTORY_PAGE_MAX).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }): Promise<ReferralAuditPage> => {
    const { supabase, userId } = context;
    const offset = data.offset ?? 0;
    const limit = data.limit ?? 20;

    const { data: access } = await supabase.rpc("has_clinical_access", { _user_id: userId });
    if (!access) throw new Error("Forbidden");

    const { data: ref } = await supabase
      .from("referrals")
      .select("id")
      .eq("id", data.referral_id)
      .maybeSingle();
    if (!ref) throw new Error("Referral not found");

    const admin = await getAdmin();
    const { data: rows, error } = await admin
      .from("audit_log")
      .select("id, user_id, action, diff, created_at")
      .eq("entity", "referral")
      .eq("entity_id", data.referral_id)
      .in("action", ["create", "update", "delete"])
      .order("created_at", { ascending: true });
    if (error) throw safeError("referrals.getReferralHistory", error, "Failed to load referral history.");

    const norm = (v: unknown): AuditValue => {
      if (v === null || v === undefined) return null;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
      return JSON.stringify(v);
    };

    const prev: Record<string, AuditValue> = {};
    const built: ReferralAuditEntry[] = [];

    for (const r of rows ?? []) {
      const diff = (r.diff ?? {}) as Record<string, unknown>;
      const base: ReferralAuditEntry = {
        id: r.id,
        action: r.action,
        created_at: r.created_at,
        user_id: r.user_id,
        user_name: "Clinician",
        changes: [],
      };

      if (r.action === "create") {
        const snap: Record<string, AuditValue> = {};
        for (const k of AUDITED_REFERRAL_FIELDS) {
          const v = norm(diff[k]);
          snap[k] = v;
          prev[k] = v;
        }
        base.snapshot = snap;
      } else if (r.action === "update") {
        for (const k of AUDITED_REFERRAL_FIELDS) {
          if (k in diff) {
            const to = norm(diff[k]);
            const from = prev[k] ?? null;
            if (from !== to) {
              base.changes.push({ field: k, from, to });
              prev[k] = to;
            }
          }
        }
        if (base.changes.length === 0) continue;
      }

      built.push(base);
    }

    built.reverse();
    const total = built.length;
    const page = built.slice(offset, offset + limit);

    const userIds = Array.from(new Set(page.map((e) => e.user_id).filter(Boolean) as string[]));
    if (userIds.length) {
      const { data: profs } = await admin
        .from("profiles")
        .select("id, full_name")
        .in("id", userIds);
      const names: Record<string, string> = {};
      profs?.forEach((p: any) => { names[p.id] = p.full_name ?? "Clinician"; });
      for (const e of page) {
        e.user_name = e.user_id ? (names[e.user_id] ?? "Clinician") : "System";
      }
    } else {
      for (const e of page) {
        if (!e.user_id) e.user_name = "System";
      }
    }

    return {
      entries: page,
      total,
      offset,
      limit,
      hasMore: offset + page.length < total,
    };
  });




export const logReferralView = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ referral_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: access } = await supabase.rpc("has_clinical_access", { _user_id: userId });
    if (!access) throw new Error("Forbidden");

    const { data: ref } = await supabase
      .from("referrals")
      .select("id")
      .eq("id", data.referral_id)
      .maybeSingle();
    if (!ref) throw new Error("Referral not found");

    await writeAudit({
      user_id: userId,
      action: "view",
      entity: "referral",
      entity_id: data.referral_id,
    });
    return { ok: true };
  });



export const deleteReferral = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: row } = await supabase
      .from("referrals")
      .select("*, created_by")
      .eq("id", data.id)
      .maybeSingle();

    if (!row) throw new Error("Referral not found");

    const { data: isAdmin } = await supabase.rpc("has_role", {
      _user_id: userId,
      _role: "admin",
    });
    if (row.created_by !== userId && !isAdmin) {
      throw new Error("Only the creator or an admin can delete this referral");
    }

    const { error } = await supabase
      .from("referrals")
      .update({ deleted_at: new Date().toISOString(), deleted_by: userId } as any)
      .eq("id", data.id)
      .is("deleted_at", null);
    if (error) throw safeError("referrals.delete", error, "Failed to delete referral.");

    await writeAudit({
      user_id: userId,
      action: "delete",
      entity: "referral",
      entity_id: data.id,
      diff: row as any,
    });

    return { ok: true };
  });


export const RESTORE_WINDOW_DAYS = 7;

export const listDeletedReferrals = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const cutoff = new Date(Date.now() - RESTORE_WINDOW_DAYS * 86400000).toISOString();
    const { data: isAdmin } = await supabase.rpc("has_role", {
      _user_id: userId,
      _role: "admin",
    });
    let query = supabase
      .from("referrals")
      .select("*")
      .not("deleted_at", "is", null)
      .gte("deleted_at", cutoff)
      .order("deleted_at", { ascending: false });
    if (!isAdmin) query = query.eq("created_by", userId);
    const { data, error } = await query;
    if (error) throw safeError("referrals.listDeleted", error, "Failed to load deleted referrals.");
    return (data ?? []).map((r) => decryptReferralRow(r as any));
  });

export const restoreReferral = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: row } = await supabase
      .from("referrals")
      .select("*, created_by, deleted_at")
      .eq("id", data.id)
      .maybeSingle();
    const { data: isAdmin } = await supabase.rpc("has_role", {
      _user_id: userId,
      _role: "admin",
    });
    const decision = decideReferralRestore({
      row: row ? { created_by: (row as any).created_by ?? null, deleted_at: (row as any).deleted_at ?? null } : null,
      userId,
      isAdmin: !!isAdmin,
      restoreWindowDays: RESTORE_WINDOW_DAYS,
    });
    if (decision.kind === "not_found") throw new Error("Referral not found");
    if (decision.kind === "not_deleted") throw new Error("Referral is not deleted");
    if (decision.kind === "forbidden") {
      throw new Error("Only the creator or an admin can restore this referral");
    }
    if (decision.kind === "window_expired") {
      throw new Error(`Restore window of ${RESTORE_WINDOW_DAYS} days has expired`);
    }


    const { error } = await supabase
      .from("referrals")
      .update({ deleted_at: null, deleted_by: null, updated_by: userId } as any)
      .eq("id", data.id);
    if (error) throw safeError("referrals.restore", error, "Failed to restore referral.");

    await writeAudit({
      user_id: userId,
      action: "update",
      entity: "referral",
      entity_id: data.id,
      diff: { restored: true },
    });
    return { ok: true };
  });


export const findReferralsByHospitalNumber = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        hospital_number: z.string().trim().min(1).max(50),
        exclude_id: z.string().uuid().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }): Promise<DecryptedReferral[]> => {
    const { supabase, userId } = context;
    await assertClinicalAccess(supabase, userId);
    const hashed = hashHospitalNumber(data.hospital_number);
    if (!hashed) return [];
    let q = supabase
      .from("referrals")
      .select(
        "id, hospital_number_enc, hospital_number_hash, referral_received_at, status, referring_specialty, current_ward, current_bed, reason_for_referral_enc, past_medical_history_enc, baseline_function_enc, age, sex, consultant_to_consultant_only, decision_at, decline_reason",
      )
      .is("deleted_at", null)
      .eq("hospital_number_hash", hashed)
      .order("referral_received_at", { ascending: false })
      .limit(50);
    if (data.exclude_id) q = q.neq("id", data.exclude_id);
    const { data: rows, error } = await q;
    if (error) throw safeError("referrals.findByHospitalNumber", error, "Failed to search referrals.");
    return (rows ?? []).map((r) => decryptReferralRow(r as any));
  });

