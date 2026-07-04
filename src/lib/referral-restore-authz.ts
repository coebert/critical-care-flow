// Pure authorization decisions for referral restore and updates on
// soft-deleted rows. Extracted so we can unit-test the rule without a live
// database. The server functions call these before touching the row; RLS
// (USING clause on `referrals`) enforces the same rule in the database as
// a second line of defence.

export interface RestoreInput {
  row: { created_by: string | null; deleted_at: string | null } | null;
  userId: string;
  isAdmin: boolean;
  now?: number;
  restoreWindowDays?: number;
}

export type RestoreDecision =
  | { kind: "allow" }
  | { kind: "not_found" }
  | { kind: "not_deleted" }
  | { kind: "forbidden" }
  | { kind: "window_expired"; deleted_at: string; windowDays: number };

export function decideReferralRestore(input: RestoreInput): RestoreDecision {
  const { row, userId, isAdmin } = input;
  const windowDays = input.restoreWindowDays ?? 7;
  if (!row) return { kind: "not_found" };
  if (!row.deleted_at) return { kind: "not_deleted" };
  if (row.created_by !== userId && !isAdmin) return { kind: "forbidden" };
  const now = input.now ?? Date.now();
  const cutoff = now - windowDays * 86400000;
  if (new Date(row.deleted_at).getTime() < cutoff) {
    return { kind: "window_expired", deleted_at: row.deleted_at, windowDays };
  }
  return { kind: "allow" };
}

export interface UpdateInput {
  row: { created_by: string | null; deleted_at: string | null } | null;
  userId: string;
  isAdmin: boolean;
}

export type UpdateDecision =
  | { kind: "allow" }
  | { kind: "not_found" }
  | { kind: "forbidden_soft_deleted" };

/**
 * A soft-deleted row may only be mutated (including a restore write) by its
 * creator or an admin. Live (non-deleted) rows fall through to the normal
 * collaborative-edit RLS policy and this evaluator returns `allow` for them.
 */
export function decideReferralUpdate(input: UpdateInput): UpdateDecision {
  const { row, userId, isAdmin } = input;
  if (!row) return { kind: "not_found" };
  if (row.deleted_at && row.created_by !== userId && !isAdmin) {
    return { kind: "forbidden_soft_deleted" };
  }
  return { kind: "allow" };
}
