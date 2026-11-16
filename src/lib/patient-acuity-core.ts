/**
 * Level-of-care / 1:1 write path (client-safe module: no server imports).
 *
 * Safety rules:
 *  - A failed read of the existing row FAILS CLOSED — nothing is written,
 *    so a read error can never clear a recorded 1:1 or level.
 *  - Only the fields the caller sent are changed (field merge). Each write
 *    is a compare-and-set on the row's `updated_at`; if another edit landed
 *    in between we re-read and re-apply only our field, so concurrent level
 *    and 1:1 edits preserve each other. Callers that pass
 *    `expected_updated_at` get an explicit conflict instead.
 *  - Flagging 1:1 without a level never invents an observed level:
 *    `level_recorded = false` and the stored level is a placeholder.
 */

export type AcuityLevel = 0 | 1 | 2 | 3;

export type AcuityEntry = {
  partner_patient_id: string;
  /** null = no level of care observed (e.g. only 1:1 is recorded). */
  level: AcuityLevel | null;
  one_to_one: boolean;
  updated_at: string;
  updated_by: string | null;
};

export type SetPatientAcuityInput = {
  partner_patient_id: string;
  /** Omitted = keep; null = clear the level; 0–3 = record it. */
  level?: AcuityLevel | null;
  /** Omitted = keep. */
  one_to_one?: boolean;
  /** When given (null = "no row expected"), mismatch returns a conflict. */
  expected_updated_at?: string | null;
};

export type SetPatientAcuityResult =
  | { ok: true; entry: AcuityEntry | null }
  | { ok: false; error: string; conflict?: boolean; entry?: AcuityEntry | null };

export type AcuityRow = {
  partner_patient_id: string;
  level: number;
  level_recorded: boolean | null;
  one_to_one: boolean;
  updated_at: string;
  updated_by: string | null;
};

const TABLE = "patient_acuity_overrides";
export const ACUITY_SELECT = "partner_patient_id, level, level_recorded, one_to_one, updated_at, updated_by";

type Res<T> = PromiseLike<{ data: T; error: { message: string; code?: string } | null }>;

/** Minimal slice of the Supabase client used here (injectable for tests). */
export type AcuityDb = {
  rpc: (fn: "has_clinical_access", args: { _user_id: string }) => Res<unknown>;
  from: (table: typeof TABLE) => any;
};

export function toAcuityEntry(r: AcuityRow | null | undefined): AcuityEntry | null {
  if (!r) return null;
  const observed = r.level_recorded !== false && [0, 1, 2, 3].includes(Number(r.level));
  return {
    partner_patient_id: r.partner_patient_id,
    level: observed ? (Number(r.level) as AcuityLevel) : null,
    one_to_one: r.one_to_one === true,
    updated_at: r.updated_at,
    updated_by: r.updated_by ?? null,
  };
}

const sameInstant = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? null) === (b ?? null) || (!!a && !!b && Date.parse(a) === Date.parse(b));

export function validateAcuityInput(data: SetPatientAcuityInput): SetPatientAcuityInput {
  if (!data || typeof data.partner_patient_id !== "string" || !data.partner_patient_id) {
    throw new Error("partner_patient_id is required");
  }
  if (data.level !== undefined && data.level !== null && ![0, 1, 2, 3].includes(data.level as number)) {
    throw new Error("level must be 0, 1, 2, 3, or null");
  }
  if (data.one_to_one !== undefined && typeof data.one_to_one !== "boolean") {
    throw new Error("one_to_one must be a boolean");
  }
  if (
    data.expected_updated_at !== undefined &&
    data.expected_updated_at !== null &&
    (typeof data.expected_updated_at !== "string" || !Number.isFinite(Date.parse(data.expected_updated_at)))
  ) {
    throw new Error("expected_updated_at must be an ISO timestamp or null");
  }
  if (data.level === undefined && data.one_to_one === undefined) {
    throw new Error("nothing to change");
  }
  return data;
}

const MAX_ATTEMPTS = 3;

export async function applyAcuityChange(
  db: AcuityDb,
  userId: string,
  input: SetPatientAcuityInput,
  deps: { now?: () => Date } = {},
): Promise<SetPatientAcuityResult> {
  const id = input.partner_patient_id;
  const now = deps.now ?? (() => new Date());
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { data: existing, error: readErr } = (await db
      .from(TABLE)
      .select(ACUITY_SELECT)
      .eq("partner_patient_id", id)
      .maybeSingle()) as { data: AcuityRow | null; error: { message: string } | null };
    if (readErr) {
      return { ok: false, error: "Could not read the current level of care — nothing was changed. Try again." };
    }
    if (input.expected_updated_at !== undefined && !sameInstant(existing?.updated_at, input.expected_updated_at)) {
      return {
        ok: false,
        conflict: true,
        error: "Level of care was changed by someone else — review the latest value and try again.",
        entry: toAcuityEntry(existing),
      };
    }
    const stamp = { updated_by: userId, updated_at: now().toISOString() };

    if (!existing) {
      const wantLevel = input.level ?? null;
      const wantOne = input.one_to_one ?? false;
      if (wantLevel === null && !wantOne) return { ok: true, entry: null };
      const { data: row, error } = await db
        .from(TABLE)
        .insert({
          partner_patient_id: id,
          // NOT NULL column: placeholder only when no level is observed.
          level: wantLevel ?? 0,
          level_recorded: wantLevel !== null,
          one_to_one: wantOne,
          ...stamp,
        })
        .select(ACUITY_SELECT)
        .maybeSingle();
      if (error) {
        if (error.code === "23505") continue; // concurrent insert — merge into it
        return { ok: false, error: "Could not save the level of care." };
      }
      return { ok: true, entry: toAcuityEntry(row as AcuityRow) };
    }

    const patch: Record<string, unknown> = { ...stamp };
    if (input.level !== undefined) {
      if (input.level === null) patch.level_recorded = false;
      else {
        patch.level = input.level;
        patch.level_recorded = true;
      }
    }
    if (input.one_to_one !== undefined) patch.one_to_one = input.one_to_one;
    const nextRecorded = (patch.level_recorded as boolean | undefined) ?? existing.level_recorded !== false;
    const nextOne = (patch.one_to_one as boolean | undefined) ?? existing.one_to_one === true;

    if (!nextRecorded && !nextOne) {
      // Nothing left to record — delete, but only the row version we read.
      const { data: gone, error } = await db
        .from(TABLE)
        .delete()
        .eq("partner_patient_id", id)
        .eq("updated_at", existing.updated_at)
        .select("partner_patient_id");
      if (error) return { ok: false, error: "Could not clear the level of care." };
      if (!gone || (gone as unknown[]).length === 0) continue; // changed underneath us
      return { ok: true, entry: null };
    }

    const { data: rows, error } = await db
      .from(TABLE)
      .update(patch)
      .eq("partner_patient_id", id)
      .eq("updated_at", existing.updated_at)
      .select(ACUITY_SELECT);
    if (error) return { ok: false, error: "Could not save the level of care." };
    if (!rows || (rows as unknown[]).length === 0) {
      if (input.expected_updated_at !== undefined) {
        return { ok: false, conflict: true, error: "Level of care was changed by someone else — try again." };
      }
      continue; // concurrent edit — re-read and re-apply only our field
    }
    return { ok: true, entry: toAcuityEntry((rows as AcuityRow[])[0]) };
  }
  return {
    ok: false,
    conflict: true,
    error: "Level of care kept changing while saving — reload and try again.",
  };
}

/** Full handler body: clinical check → merge write → capacity re-evaluation. */
export async function runSetPatientAcuity(
  db: AcuityDb,
  userId: string,
  input: SetPatientAcuityInput,
  deps: { now?: () => Date; reevaluateCapacity?: () => Promise<unknown> } = {},
): Promise<SetPatientAcuityResult> {
  const { data: allowed, error: roleErr } = await db.rpc("has_clinical_access", { _user_id: userId });
  if (roleErr) return { ok: false, error: "Permission check failed — nothing was changed." };
  if (allowed !== true) return { ok: false, error: "forbidden: clinical role required" };
  const result = await applyAcuityChange(db, userId, input, deps);
  if (result.ok && deps.reevaluateCapacity) {
    try {
      await deps.reevaluateCapacity();
    } catch {
      console.warn("[acuity] capacity re-evaluation failed");
    }
  }
  return result;
}
