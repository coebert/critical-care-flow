import { describe, it, expect, vi } from "vitest";
import { writeAudit, redactEncryptedFromDiff } from "./referrals.functions";
import {
  normalizeIncomingBridgeRecord,
  auditBridgeNormalizationEvents,
} from "./bridge-normalize";

/**
 * Integration coverage: every mutation that touches a referral (create,
 * update, partner-bridge patient_initials normalisation) must land an
 * `audit_log` row so we can trace who changed what and — for partner-
 * origin identifier rewrites — how the value was normalised.
 *
 * The production writers are:
 *   - `writeAudit`  from src/lib/referrals.functions.ts
 *       Used by `createReferral` (line ~344, action: "create") and
 *       `updateReferral` (line ~454, action: "update"). Redacts every
 *       ENCRYPTED_TEXT_FIELDS entry so audit_log never leaks plaintext
 *       for columns stored as *_enc.
 *   - `auditBridgeNormalizationEvents` from src/lib/bridge-normalize.ts
 *       Called by the bridge sync + resource routes whenever a full_name
 *       or patient_initials value is converted or cleared during
 *       normalizeIncomingBridgeRecord.
 *
 * Both accept an injectable admin capture, so we can assert the exact
 * insert payload without spinning up Supabase.
 */

interface Capture {
  table: string;
  row: Record<string, unknown>;
}

function makeAdminCapture(): {
  admin: { from: (t: string) => { insert: (row: any) => Promise<{ error: null }> } };
  captures: Capture[];
} {
  const captures: Capture[] = [];
  const admin = {
    from: (table: string) => ({
      insert: async (row: any) => {
        captures.push({ table, row });
        return { error: null };
      },
    }),
  };
  return { admin, captures };
}

const REFERRAL_ID = "11111111-2222-3333-4444-555555555555";
const ACTOR_ID = "00000000-0000-0000-0000-0000000000aa";

describe("referral create/update actions write audit_log entries", () => {
  it("createReferral writes a 'create' audit row with encrypted fields redacted", async () => {
    const { admin, captures } = makeAdminCapture();

    // Same shape createReferral produces at line ~332:
    //   diff: { ...(data as any) }  → user-supplied create payload.
    await writeAudit(
      {
        user_id: ACTOR_ID,
        action: "create",
        entity: "referral",
        entity_id: REFERRAL_ID,
        diff: {
          hospital_number: "H123",
          referring_specialty: "Respiratory",
          current_ward: "Ward 7B",
          reason_for_referral: "SEVERE HYPOXIA — plaintext must not persist",
          past_medical_history: "IHD, COPD",
          baseline_function: "Independent",
          allergies: "NKDA",
          status: "pending",
          is_test: true,
        },
      },
      admin,
    );

    expect(captures).toHaveLength(1);
    const [c] = captures;
    expect(c.table).toBe("audit_log");
    expect(c.row).toMatchObject({
      user_id: ACTOR_ID,
      action: "create",
      entity: "referral",
      entity_id: REFERRAL_ID,
    });

    const diff = c.row.diff as Record<string, unknown>;
    // Non-encrypted fields pass through verbatim.
    expect(diff.referring_specialty).toBe("Respiratory");
    expect(diff.current_ward).toBe("Ward 7B");
    expect(diff.status).toBe("pending");
    expect(diff.is_test).toBe(true);
    // Non-encrypted allergies pass through.
    expect(diff.allergies).toBe("NKDA");

    // Encrypted plaintext columns MUST be redacted — including
    // hospital_number (encrypted + hashed on write).
    expect(diff.hospital_number).toBe("[encrypted]");
    expect(diff.reason_for_referral).toBe("[encrypted]");
    expect(diff.past_medical_history).toBe("[encrypted]");
    expect(diff.baseline_function).toBe("[encrypted]");

    // Ciphertext + hash columns MUST NOT leak.
    expect(diff).not.toHaveProperty("reason_for_referral_enc");
    expect(diff).not.toHaveProperty("past_medical_history_enc");
    expect(diff).not.toHaveProperty("hospital_number_hash");
  });

  it("updateReferral writes an 'update' audit row with the patch (encrypted fields redacted)", async () => {
    const { admin, captures } = makeAdminCapture();

    // Same shape updateReferral produces at line ~442:
    //   diff: { ...(data.patch as any) }  → the patch the caller sent.
    await writeAudit(
      {
        user_id: ACTOR_ID,
        action: "update",
        entity: "referral",
        entity_id: REFERRAL_ID,
        diff: {
          status: "accepted",
          accepting_consultant: "Dr Grey",
          decision_at: "2026-07-11T09:00:00Z",
          reason_for_referral: "UPDATED plaintext must not persist",
        },
      },
      admin,
    );

    expect(captures).toHaveLength(1);
    const [c] = captures;
    expect(c.table).toBe("audit_log");
    expect(c.row).toMatchObject({
      user_id: ACTOR_ID,
      action: "update",
      entity: "referral",
      entity_id: REFERRAL_ID,
    });
    const diff = c.row.diff as Record<string, unknown>;
    expect(diff.status).toBe("accepted");
    expect(diff.accepting_consultant).toBe("Dr Grey");
    expect(diff.decision_at).toBe("2026-07-11T09:00:00Z");
    expect(diff.reason_for_referral).toBe("[encrypted]");
  });

  it("redactEncryptedFromDiff is idempotent and safe on empty diffs", () => {
    expect(redactEncryptedFromDiff({})).toEqual({});
    const once = redactEncryptedFromDiff({
      past_medical_history: "leak me",
      status: "pending",
    });
    expect(once).toEqual({
      past_medical_history: "[encrypted]",
      status: "pending",
    });
    const twice = redactEncryptedFromDiff(once);
    expect(twice).toEqual(once);
  });

  it("captures the referral_note context on note audit rows", async () => {
    const { admin, captures } = makeAdminCapture();
    await writeAudit(
      {
        user_id: ACTOR_ID,
        action: "create",
        entity: "referral_note",
        entity_id: "22222222-2222-2222-2222-222222222222",
        referral_id: REFERRAL_ID,
        author_id: ACTOR_ID,
        recipient_count: 3,
        edited_at: null,
        diff: { body: "note plaintext" },
      },
      admin,
    );
    const diff = captures[0].row.diff as Record<string, unknown>;
    expect(diff.body).toBe("[encrypted]");
    expect(diff.actor_id).toBe(ACTOR_ID);
    expect(diff.author_id).toBe(ACTOR_ID);
    expect(diff.via_admin_flow).toBe(false);
    expect(diff.referral_id).toBe(REFERRAL_ID);
    expect(diff.recipient_count).toBe(3);
  });
});

describe("normalizeIncomingBridgeRecord writes a bridge_initials_normalization audit row", () => {
  it("converting full_name → initials on a partner patient row is audited", async () => {
    const { admin, captures } = makeAdminCapture();

    const raw = { id: "p1", full_name: "Jane Smith", weight_kg: 70 };
    const { record, events } = normalizeIncomingBridgeRecord("patients", raw);

    // Normalisation itself must have converted the full name to initials.
    expect(record.full_name).toBe("JS");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      field: "full_name",
      kind: "converted",
      before: "Jane Smith",
      after: "JS",
    });

    await auditBridgeNormalizationEvents(admin, {
      resource: "patients",
      entityId: "p1",
      actor: { source: "partner", email: "partner@example.com" },
      source: "bridge_pull",
      events,
    });

    expect(captures).toHaveLength(1);
    const [c] = captures;
    expect(c.table).toBe("audit_log");
    expect(c.row).toMatchObject({
      user_id: null,
      action: "update",
      entity: "bridge_initials_normalization",
      entity_id: "p1",
    });
    const diff = c.row.diff as any;
    expect(diff.source).toBe("bridge_pull");
    expect(diff.resource).toBe("patients");
    expect(diff.events).toHaveLength(1);
    expect(diff.events[0]).toMatchObject({
      field: "full_name",
      kind: "converted",
      before: "Jane Smith",
      after: "JS",
    });
  });

  it("an already-normalised single-letter patient_initials is folded into full_name and NOT re-audited", async () => {
    const { admin, captures } = makeAdminCapture();

    // Single-letter values are the only strictly idempotent input under
    // toInitials() — multi-letter tokens collapse to their first letter,
    // which is a real quirk callers rely on. Use "A" so the record round-
    // trips without a normalisation event.
    const { record, events } = normalizeIncomingBridgeRecord("patients", {
      id: "p2",
      patient_initials: "A",
    });
    expect(record.full_name).toBe("A");
    expect(record).not.toHaveProperty("patient_initials");
    expect(events).toHaveLength(0);

    await auditBridgeNormalizationEvents(admin, {
      resource: "patients",
      entityId: "p2",
      actor: null,
      source: "bridge_pull",
      events,
    });
    expect(captures).toHaveLength(0);
  });

  it("clearing a letterless patient_initials value on bed_occupancies is audited", async () => {
    const { admin, captures } = makeAdminCapture();

    const { record, events } = normalizeIncomingBridgeRecord(
      "bed_occupancies",
      { id: "occ1", patient_initials: "12345" },
    );
    expect(record.patient_initials).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      field: "patient_initials",
      kind: "cleared",
      before: "12345",
      after: null,
    });

    await auditBridgeNormalizationEvents(admin, {
      resource: "bed_occupancies",
      entityId: "occ1",
      actor: { source: "sync_worker" },
      source: "bridge_push",
      events,
    });

    expect(captures).toHaveLength(1);
    const diff = captures[0].row.diff as any;
    expect(diff.source).toBe("bridge_push");
    expect(diff.resource).toBe("bed_occupancies");
    expect(diff.events[0].kind).toBe("cleared");
    expect(diff.events[0].after).toBeNull();
  });

  it("swallows admin insert errors so audit failures never block the sync write", async () => {
    const throwingAdmin = {
      from: () => ({
        insert: async () => {
          throw new Error("audit_log unavailable");
        },
      }),
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      auditBridgeNormalizationEvents(throwingAdmin, {
        resource: "patients",
        entityId: "p3",
        actor: null,
        source: "bridge_pull",
        events: [
          {
            field: "full_name",
            kind: "converted",
            before: "Bob Jones",
            after: "BJ",
          },
        ],
      }),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
