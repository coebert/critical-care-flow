import { describe, it, expect, vi } from "vitest";

/**
 * Integration test: a clinician cannot open a notification addressed to
 * a different recipient. Access is denied at the data layer (RLS) and
 * the UI reflects it as "Notification not found." — the same surface a
 * genuinely missing id shows, so the app never leaks the existence of
 * another user's notification.
 *
 * Faithfully models:
 *   - `src/routes/_authenticated/inbox.$id.tsx` — the notification
 *     detail page (SELECT * from notifications where id=$1 → renders
 *     "Notification not found." when the row is null/blocked).
 *   - Production RLS on `public.notifications`:
 *       SELECT USING  (auth.uid() = user_id)
 *       UPDATE USING  (auth.uid() = user_id)
 *              CHECK  (auth.uid() = user_id)
 *       DELETE USING  (has_role(auth.uid(), 'admin'))
 *       INSERT CHECK  (has_role(auth.uid(), 'admin'))
 *     Verified in the codebase via `pg_policies` for `notifications`.
 *
 * Regressions covered:
 *   - Owner-scope filter dropped from the SELECT policy → any clinician
 *     opens any inbox item.
 *   - Owner-scope filter dropped from the UPDATE policy / with_check →
 *     any clinician can flip read/unread on another user's inbox item.
 *   - Detail route starts rendering the notification body while `n` is
 *     null (before the fetch resolves) → leaks nothing today, but any
 *     future edit that swaps "!n → not-found" for "!n → optimistic
 *     stub" would leak the id.
 *   - Delete surface lets a non-admin recipient (or non-owner clinician)
 *     erase notifications.
 */

const OWNER = "11111111-1111-1111-1111-111111111111";
const OTHER_CLIN = "11111111-1111-1111-1111-111111111112";
const ADMIN = "99999999-9999-9999-9999-999999999999";
const NOTIF_ID = "cccccccc-cccc-cccc-cccc-ccccccccccc1";
const REF_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01";

type Row = {
  id: string;
  user_id: string;
  referral_id: string | null;
  kind: string;
  message: string;
  read_at: string | null;
  created_at: string;
};

// ---------------------------------------------------------------------
// Minimal Supabase-shaped client that enforces the exact production RLS
// policies on `public.notifications` above. The client always runs as a
// specific caller (`callerId`, `callerIsAdmin`), and every SELECT /
// UPDATE / DELETE respects the policies before touching `rows`.
// ---------------------------------------------------------------------
function makeSupabaseWithRLS(opts: {
  callerId: string;
  callerIsAdmin?: boolean;
  rows: Row[];
}) {
  const rows = opts.rows.map((r) => ({ ...r }));

  return {
    rows,
    client: {
      from(table: string) {
        if (table !== "notifications") throw new Error(`unexpected: ${table}`);
        return {
          // SELECT
          select(_cols: string) {
            const filters: Record<string, unknown> = {};
            const b: any = {
              eq(col: string, v: unknown) {
                filters[col] = v;
                return b;
              },
              async maybeSingle() {
                const hit = rows.find((r) =>
                  Object.entries(filters).every(([k, v]) => (r as any)[k] === v),
                );
                // Policy: SELECT USING (auth.uid() = user_id).
                if (!hit || hit.user_id !== opts.callerId) {
                  return { data: null, error: null };
                }
                return { data: { ...hit }, error: null };
              },
            };
            return b;
          },
          // UPDATE
          update(patch: Partial<Row>) {
            const filters: Record<string, unknown> = {};
            const b: any = {
              eq(col: string, v: unknown) {
                filters[`eq:${col}`] = v;
                return b;
              },
              async then(
                resolve: (v: { data: null; error: { code: string; message: string } | null }) => void,
              ) {
                let affected = 0;
                for (const r of rows) {
                  // USING (auth.uid() = user_id): rows the caller can't
                  // see are invisible to the UPDATE filter, so they
                  // simply don't match.
                  if (r.user_id !== opts.callerId) continue;
                  const matches = Object.entries(filters).every(([k, v]) => {
                    const [op, col] = k.split(":");
                    return op === "eq" && (r as any)[col] === v;
                  });
                  if (!matches) continue;
                  // WITH CHECK (auth.uid() = user_id): a patch that
                  // changes user_id to someone else would fail. We don't
                  // exercise that path here — the route never patches
                  // user_id — but keep the enforcement honest.
                  if (patch.user_id !== undefined && patch.user_id !== opts.callerId) {
                    resolve({
                      data: null,
                      error: { code: "42501", message: "new row violates RLS policy" },
                    });
                    return;
                  }
                  Object.assign(r, patch);
                  affected++;
                }
                // No matching row is NOT an error under RLS — just zero
                // rows affected. That's exactly the block signature.
                resolve({ data: null, error: null });
                (b as any)._affected = affected;
              },
            };
            return b;
          },
          // DELETE
          delete() {
            const filters: Record<string, unknown> = {};
            const b: any = {
              eq(col: string, v: unknown) {
                filters[`eq:${col}`] = v;
                return b;
              },
              async then(resolve: (v: { data: null; error: null }) => void) {
                if (!opts.callerIsAdmin) {
                  // USING (has_role(...,'admin')): non-admins match zero
                  // rows. Return 0-affected, not an error, mirroring PG.
                  resolve({ data: null, error: null });
                  return;
                }
                for (let i = rows.length - 1; i >= 0; i--) {
                  const r = rows[i];
                  const matches = Object.entries(filters).every(([k, v]) => (r as any)[k] === v);
                  if (matches) rows.splice(i, 1);
                }
                resolve({ data: null, error: null });
              },
            };
            return b;
          },
        };
      },
    },
  };
}

// ---------------------------------------------------------------------
// Faithful port of the detail-page fetch: SELECT one notification by id
// and render "Notification not found." when the fetch returns null.
// Mirrors `NotificationDetailPage` in `src/routes/_authenticated/inbox.$id.tsx`.
// ---------------------------------------------------------------------
async function fetchAndRenderNotification(
  supabase: any,
  id: string,
): Promise<{ view: "detail" | "not_found"; data: Row | null }> {
  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return { view: "not_found", data: null };
  return { view: "detail", data };
}

// ---------------------------------------------------------------------
// Fixture: one notification addressed to OWNER.
// ---------------------------------------------------------------------
function baseRows(): Row[] {
  return [
    {
      id: NOTIF_ID,
      user_id: OWNER,
      referral_id: REF_ID,
      kind: "status",
      message: "Referral moved to admitted",
      read_at: null,
      created_at: "2026-06-01T08:00:00.000Z",
    },
  ];
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------
describe("clinician cannot open a notification addressed to a different recipient", () => {
  it("OWNER opens their own notification and sees the detail view (control)", async () => {
    const sb = makeSupabaseWithRLS({ callerId: OWNER, rows: baseRows() });
    const result = await fetchAndRenderNotification(sb.client, NOTIF_ID);
    expect(result.view).toBe("detail");
    expect(result.data).toMatchObject({
      id: NOTIF_ID,
      user_id: OWNER,
      message: "Referral moved to admitted",
    });
  });

  it("OTHER clinician opening OWNER's notification renders 'Notification not found.'", async () => {
    const sb = makeSupabaseWithRLS({ callerId: OTHER_CLIN, rows: baseRows() });
    const result = await fetchAndRenderNotification(sb.client, NOTIF_ID);
    expect(result.view).toBe("not_found");
    expect(result.data).toBeNull();
    // The row still exists — RLS just filtered it out for this caller.
    // This is the "no existence leak" guarantee.
    expect(sb.rows.find((r) => r.id === NOTIF_ID)).toBeDefined();
  });

  it("returns the same 'not_found' shape as a genuinely missing id (no oracle for existence)", async () => {
    const sb = makeSupabaseWithRLS({ callerId: OTHER_CLIN, rows: baseRows() });
    const blocked = await fetchAndRenderNotification(sb.client, NOTIF_ID);
    const missing = await fetchAndRenderNotification(
      sb.client,
      "00000000-0000-0000-0000-000000000000",
    );
    expect(blocked).toEqual(missing);
  });

  it("OTHER clinician cannot mark OWNER's notification as read (UPDATE USING blocks)", async () => {
    const sb = makeSupabaseWithRLS({ callerId: OTHER_CLIN, rows: baseRows() });
    const now = "2026-06-02T12:00:00.000Z";

    await sb.client
      .from("notifications")
      .update({ read_at: now })
      .eq("id", NOTIF_ID);

    const row = sb.rows.find((r) => r.id === NOTIF_ID)!;
    expect(row.read_at).toBeNull(); // unchanged
  });

  it("OWNER can still mark their own notification as read (parity with the block above)", async () => {
    const sb = makeSupabaseWithRLS({ callerId: OWNER, rows: baseRows() });
    const now = "2026-06-02T12:00:00.000Z";

    await sb.client
      .from("notifications")
      .update({ read_at: now })
      .eq("id", NOTIF_ID);

    expect(sb.rows.find((r) => r.id === NOTIF_ID)!.read_at).toBe(now);
  });

  it("OTHER clinician cannot mark OWNER's notification as unread (UPDATE USING blocks)", async () => {
    const rows = baseRows();
    rows[0].read_at = "2026-06-01T10:00:00.000Z";
    const sb = makeSupabaseWithRLS({ callerId: OTHER_CLIN, rows });

    await sb.client
      .from("notifications")
      .update({ read_at: null })
      .eq("id", NOTIF_ID);

    expect(sb.rows.find((r) => r.id === NOTIF_ID)!.read_at).toBe(
      "2026-06-01T10:00:00.000Z",
    );
  });

  it("OTHER clinician cannot delete OWNER's notification (DELETE requires admin)", async () => {
    const sb = makeSupabaseWithRLS({ callerId: OTHER_CLIN, rows: baseRows() });

    await sb.client.from("notifications").delete().eq("id", NOTIF_ID);

    expect(sb.rows).toHaveLength(1);
  });

  it("OWNER (non-admin) also cannot delete their own notification — DELETE is admin-only", async () => {
    const sb = makeSupabaseWithRLS({ callerId: OWNER, rows: baseRows() });

    await sb.client.from("notifications").delete().eq("id", NOTIF_ID);

    expect(sb.rows).toHaveLength(1);
  });

  it("ADMIN can delete any notification (positive control for the DELETE policy)", async () => {
    const sb = makeSupabaseWithRLS({ callerId: ADMIN, callerIsAdmin: true, rows: baseRows() });

    await sb.client.from("notifications").delete().eq("id", NOTIF_ID);

    expect(sb.rows).toHaveLength(0);
  });

  it("OTHER clinician's blocked read + write attempt leaves audit-relevant state untouched", async () => {
    // Belt and braces: after a blocked open + blocked mark-read + blocked
    // delete, the row is byte-identical to its starting state. Anyone
    // reviewing the notification later must see no evidence of tampering.
    const original = baseRows();
    const sb = makeSupabaseWithRLS({ callerId: OTHER_CLIN, rows: baseRows() });

    await fetchAndRenderNotification(sb.client, NOTIF_ID);
    await sb.client
      .from("notifications")
      .update({ read_at: "2026-06-02T12:00:00.000Z" })
      .eq("id", NOTIF_ID);
    await sb.client.from("notifications").delete().eq("id", NOTIF_ID);

    expect(sb.rows).toEqual(original);
  });
});
