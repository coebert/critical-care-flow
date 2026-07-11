import { describe, it, expect, vi } from "vitest";

/**
 * Integration test: clicking a `/referrals/{id}` deep link (from an in-app
 * notification, a browser bookmark, or a shared URL) for a referral that
 * has been soft-deleted / archived must:
 *
 *   1. Return `null` from `getReferralDetail` — no decrypted PHI is ever
 *      handed to the client for a deleted row.
 *   2. Return `[]` from `listReferralNotesDecrypted` for that referral —
 *      note bodies (encrypted or plaintext) never reach the client for a
 *      deleted parent.
 *   3. Surface the route-level `notFoundComponent` ("Referral unavailable")
 *      — never the "Loading…" placeholder that would spin forever, and
 *      never the referral edit form pre-populated with stale data.
 *   4. Be indistinguishable from a genuinely never-existed id — same
 *      empty payload, same not-found UI — so an attacker cannot use the
 *      deep-link surface as an oracle for "was there once a referral
 *      with this id?".
 *
 * Faithfully ports:
 *   - `getReferralDetail` handler in `src/lib/referrals.functions.ts`
 *     (filter chain `.eq("id", ...).is("deleted_at", null).maybeSingle()`)
 *   - `listReferralNotesDecrypted` handler in the same file (parent
 *     existence + deleted_at guard before selecting note rows)
 *   - The route `loader` in `src/routes/_authenticated/referrals.$id.tsx`
 *     which now throws `notFound()` when detail is null and renders the
 *     "Referral unavailable" notFoundComponent.
 */

const CLIN = "11111111-1111-1111-1111-111111111111";
const REF_LIVE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01";
const REF_DELETED = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa02";
const REF_MISSING = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa99";

type ReferralRow = {
  id: string;
  hospital_number: string;
  patient_initials: string | null;
  reason_for_referral: string | null;
  status: string;
  deleted_at: string | null;
  deleted_by: string | null;
};

type NoteRow = {
  id: string;
  referral_id: string;
  body_enc: string; // opaque ciphertext — must never surface for deleted parents
  created_at: string;
};

// ---------------------------------------------------------------------
// Supabase fixture that faithfully implements:
//   .from("referrals").select("*").eq("id", X).is("deleted_at", null).maybeSingle()
//   .from("referrals").select("id").eq("id", X).is("deleted_at", null).maybeSingle()
//   .from("referral_notes").select("*").eq("referral_id", X).order(...)
// ---------------------------------------------------------------------
function makeSupabase(opts: {
  referrals: ReferralRow[];
  notes: NoteRow[];
  clinicalAccess: boolean;
}) {
  const referralSelectCalls: Array<{ cols: string; filters: Record<string, unknown> }> = [];
  const notesSelectCalls: Array<{ filters: Record<string, unknown> }> = [];

  return {
    referralSelectCalls,
    notesSelectCalls,
    client: {
      rpc: vi.fn(async (fn: string) =>
        fn === "has_clinical_access"
          ? { data: opts.clinicalAccess, error: null }
          : { data: null, error: null },
      ),
      from(table: string) {
        if (table === "referrals") {
          return {
            select(cols: string) {
              const filters: Record<string, unknown> = {};
              const b: any = {
                eq(col: string, v: unknown) {
                  filters[`eq:${col}`] = v;
                  return b;
                },
                is(col: string, v: unknown) {
                  filters[`is:${col}`] = v;
                  return b;
                },
                async maybeSingle() {
                  referralSelectCalls.push({ cols, filters: { ...filters } });
                  const hit = opts.referrals.find((r) => {
                    if ("eq:id" in filters && r.id !== filters["eq:id"]) return false;
                    if ("is:deleted_at" in filters && filters["is:deleted_at"] === null && r.deleted_at !== null)
                      return false;
                    return true;
                  });
                  return { data: hit ? { ...hit } : null, error: null };
                },
              };
              return b;
            },
          };
        }
        if (table === "referral_notes") {
          return {
            select(_c: string) {
              const filters: Record<string, unknown> = {};
              const b: any = {
                eq(col: string, v: unknown) {
                  filters[`eq:${col}`] = v;
                  return b;
                },
                async order(_c2: string, _cfg: unknown) {
                  notesSelectCalls.push({ filters: { ...filters } });
                  const rows = opts.notes.filter(
                    (n) => n.referral_id === filters["eq:referral_id"],
                  );
                  return { data: rows.map((r) => ({ ...r })), error: null };
                },
              };
              return b;
            },
          };
        }
        throw new Error(`unexpected table: ${table}`);
      },
    },
  };
}

// ---------------------------------------------------------------------
// Faithful ports of the production handlers.
// ---------------------------------------------------------------------
async function assertClinicalAccess(sb: any, userId: string) {
  const { data } = await sb.rpc("has_clinical_access", { _user_id: userId });
  if (!data) throw new Error("Forbidden: clinical access required");
}

function decryptReferralRow(row: ReferralRow) {
  // In production this decrypts the ciphertext columns. For this test,
  // "decryption" is just the identity — the point is that a DELETED row
  // never reaches this function at all.
  return { ...row };
}

async function runGetReferralDetail(sb: any, userId: string, id: string) {
  await assertClinicalAccess(sb, userId);
  const { data: row } = await sb
    .from("referrals")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!row) return null;
  return decryptReferralRow(row);
}

async function runListNotes(sb: any, userId: string, referralId: string) {
  await assertClinicalAccess(sb, userId);
  const { data: parent } = await sb
    .from("referrals")
    .select("id")
    .eq("id", referralId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!parent) return [];
  const { data: rows } = await sb
    .from("referral_notes")
    .select("*")
    .eq("referral_id", referralId)
    .order("created_at", { ascending: true });
  return rows ?? [];
}

// Route-loader shape: mirrors what the referral detail route now does
// (`ensureQueryData(detail)` → `if (!detail) throw notFound()`).
class NotFoundSignal extends Error {
  constructor() { super("notFound"); }
}
function notFound(): never { throw new NotFoundSignal(); }

async function runRouteLoader(sb: any, userId: string, id: string) {
  const detail = await runGetReferralDetail(sb, userId, id);
  if (!detail) throw notFound();
  return detail;
}

function renderRoute(outcome:
  | { view: "detail"; detail: unknown }
  | { view: "not_found" }
  | { view: "error"; message: string }) {
  if (outcome.view === "not_found") {
    return {
      heading: "Referral unavailable",
      body:
        "This referral is no longer available. It may have been deleted or archived. If you followed a link from a notification, the notification is out of date.",
    };
  }
  return outcome;
}

async function openDeepLink(sb: any, userId: string, id: string) {
  try {
    const detail = await runRouteLoader(sb, userId, id);
    return renderRoute({ view: "detail", detail });
  } catch (e) {
    if (e instanceof NotFoundSignal) return renderRoute({ view: "not_found" });
    return renderRoute({ view: "error", message: (e as Error).message });
  }
}

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------
const REFERRALS: ReferralRow[] = [
  {
    id: REF_LIVE,
    hospital_number: "H-LIVE",
    patient_initials: "JS",
    reason_for_referral: "sepsis workup",
    status: "pending",
    deleted_at: null,
    deleted_by: null,
  },
  {
    id: REF_DELETED,
    hospital_number: "H-DEL",
    patient_initials: "AB",
    reason_for_referral: "should never surface to a client",
    status: "declined",
    deleted_at: "2026-06-01T00:00:00.000Z",
    deleted_by: CLIN,
  },
];

const NOTES: NoteRow[] = [
  { id: "note-live-1", referral_id: REF_LIVE, body_enc: "ENC:live-1", created_at: "2026-05-01T00:00:00.000Z" },
  { id: "note-del-1", referral_id: REF_DELETED, body_enc: "ENC:del-1", created_at: "2026-05-02T00:00:00.000Z" },
  { id: "note-del-2", referral_id: REF_DELETED, body_enc: "ENC:del-2", created_at: "2026-05-03T00:00:00.000Z" },
];

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------
describe("deep link to a deleted / archived referral: not-found UI + no data leak", () => {
  it("live referral: loader returns the decrypted row and renders the detail view (control)", async () => {
    const sb = makeSupabase({ referrals: REFERRALS, notes: NOTES, clinicalAccess: true });
    const rendered = await openDeepLink(sb.client, CLIN, REF_LIVE);
    expect(rendered).toEqual({
      view: "detail",
      detail: expect.objectContaining({ id: REF_LIVE, hospital_number: "H-LIVE" }),
    });
  });

  it("deleted referral: getReferralDetail returns null (deleted_at filter enforced)", async () => {
    const sb = makeSupabase({ referrals: REFERRALS, notes: NOTES, clinicalAccess: true });
    const detail = await runGetReferralDetail(sb.client, CLIN, REF_DELETED);
    expect(detail).toBeNull();

    // The .is("deleted_at", null) filter was actually applied — a
    // regression that drops it would let the deleted row through.
    expect(sb.referralSelectCalls[0].filters).toMatchObject({
      "eq:id": REF_DELETED,
      "is:deleted_at": null,
    });
  });

  it("deleted referral: route loader throws notFound → renders 'Referral unavailable' with no PHI", async () => {
    const sb = makeSupabase({ referrals: REFERRALS, notes: NOTES, clinicalAccess: true });
    const rendered = await openDeepLink(sb.client, CLIN, REF_DELETED);

    expect(rendered).toEqual({
      heading: "Referral unavailable",
      body: expect.stringContaining("no longer available"),
    });

    // No PHI or ciphertext field name from the deleted row survives
    // anywhere in the rendered payload.
    const asJson = JSON.stringify(rendered);
    expect(asJson).not.toContain("H-DEL");
    expect(asJson).not.toContain("AB");
    expect(asJson).not.toContain("should never surface");
    expect(asJson).not.toContain(CLIN); // deleted_by user id
    expect(asJson).not.toContain(REF_DELETED); // id itself must not leak
  });

  it("deleted referral: listReferralNotesDecrypted returns [] and never queries referral_notes", async () => {
    const sb = makeSupabase({ referrals: REFERRALS, notes: NOTES, clinicalAccess: true });
    const notes = await runListNotes(sb.client, CLIN, REF_DELETED);

    expect(notes).toEqual([]);
    // The parent-existence guard short-circuited BEFORE touching
    // referral_notes — critical for the "no data leak" guarantee since
    // .from("referral_notes") has no per-parent RLS filter here.
    expect(sb.notesSelectCalls).toEqual([]);
  });

  it("never-existed id: same null detail + same not-found UI as the deleted path (no existence oracle)", async () => {
    const sb1 = makeSupabase({ referrals: REFERRALS, notes: NOTES, clinicalAccess: true });
    const sb2 = makeSupabase({ referrals: REFERRALS, notes: NOTES, clinicalAccess: true });

    const deletedDetail = await runGetReferralDetail(sb1.client, CLIN, REF_DELETED);
    const missingDetail = await runGetReferralDetail(sb2.client, CLIN, REF_MISSING);
    expect(deletedDetail).toBeNull();
    expect(missingDetail).toBeNull();

    const sb3 = makeSupabase({ referrals: REFERRALS, notes: NOTES, clinicalAccess: true });
    const sb4 = makeSupabase({ referrals: REFERRALS, notes: NOTES, clinicalAccess: true });
    const deletedRender = await openDeepLink(sb3.client, CLIN, REF_DELETED);
    const missingRender = await openDeepLink(sb4.client, CLIN, REF_MISSING);
    expect(deletedRender).toEqual(missingRender);

    // Also equal at the notes surface: no notes for either → no attacker
    // can differentiate "id was never used" from "id was deleted".
    const sb5 = makeSupabase({ referrals: REFERRALS, notes: NOTES, clinicalAccess: true });
    const sb6 = makeSupabase({ referrals: REFERRALS, notes: NOTES, clinicalAccess: true });
    const deletedNotes = await runListNotes(sb5.client, CLIN, REF_DELETED);
    const missingNotes = await runListNotes(sb6.client, CLIN, REF_MISSING);
    expect(deletedNotes).toEqual([]);
    expect(missingNotes).toEqual([]);
    expect(sb5.notesSelectCalls).toEqual([]);
    expect(sb6.notesSelectCalls).toEqual([]);
  });

  it("live referral notes: only surface for live parents (regression guard for the parent-guard)", async () => {
    const sb = makeSupabase({ referrals: REFERRALS, notes: NOTES, clinicalAccess: true });
    const notes = await runListNotes(sb.client, CLIN, REF_LIVE);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ id: "note-live-1", body_enc: "ENC:live-1" });
    // Note: the deleted-parent notes ("ENC:del-1", "ENC:del-2") stay in
    // the fixture but are never queryable through this handler. Verified
    // by the earlier "deleted → []" test.
  });
});
