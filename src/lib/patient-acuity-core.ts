/**
 * Level-of-care / 1:1 write path (client-safe module: no server imports).
 *
 * Safety rules:
 *  - Every change carries the revision the clinician saw
 *    (`expected_updated_at`: the exact database string, or null = "no row
 *    expected"). Existing-row writes are compare-and-set IN THE DATABASE
 *    on that exact value (full microsecond precision) — never on a value we
 *    re-read, and never compared via Date.parse (which drops microseconds).
 *  - Creation with "no row expected" conflicts if a row now exists.
 *  - A failed read FAILS CLOSED — nothing is written.
 *  - Only the fields the caller sent change; omitted fields and explicit
 *    false are preserved. Concurrent edits get an explicit conflict.
 *  - Flagging 1:1 without a level never invents an observed level:
 *    `level_recorded = false` and the stored level is a placeholder.
 *  - Each write moves updated_at strictly forward (also enforced by the
 *    staged DB trigger), so an old revision can never match again.
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
  /** REQUIRED: exact revision seen (null = "no row expected"). */
  expected_updated_at: string | null;
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

/** Postgres/PostgREST timestamptz text, up to microseconds. */
const REVISION_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

/**
 * Lossless microseconds since epoch for a timestamptz string (BigInt), used
 * ONLY to move the stamp strictly forward — never as an identity check.
 */
export function revisionMicros(v: string): bigint | null {
  const m = REVISION_RE.exec(v);
  if (!m) return null;
  const frac = (m[1] ?? "").slice(1);
  const whole = v.replace(/\.\d{1,6}/, "");
  const ms = Date.parse(whole.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  if (!Number.isFinite(ms)) return null;
  return BigInt(ms) * 1000n + BigInt((frac + "000000").slice(0, 6));
}

function microsToIso(us: bigint): string {
  const ms = us / 1000n;
  const rest = Number(us % 1000n);
  const base = new Date(Number(ms)).toISOString(); // ...sss Z
  return `${base.slice(0, 23)}${String(rest).padStart(3, "0")}+00:00`;
}

/** A stamp strictly later than `after` (and not earlier than now). */
export function nextRevisionStamp(nowDate: Date, after: string | null): string {
  const nowUs = BigInt(nowDate.getTime()) * 1000n;
  const prev = after ? revisionMicros(after) : null;
  return microsToIso(prev !== null && prev >= nowUs ? prev + 1n : nowUs);
}

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
  if (data.expected_updated_at === undefined) {
    throw new Error("expected_updated_at is required (null when no level is recorded yet)");
  }
  if (
    data.expected_updated_at !== null &&
    (typeof data.expected_updated_at !== "string" || revisionMicros(data.expected_updated_at) === null)
  ) {
    throw new Error("expected_updated_at must be the exact revision timestamp or null");
  }
  if (data.level === undefined && data.one_to_one === undefined) {
    throw new Error("nothing to change");
  }
  return data;
}

const CONFLICT = "Level of care was changed by someone else — the latest value is shown. Review it and choose again.";

async function readCurrent(db: AcuityDb, id: string) {
  return (await db
    .from(TABLE)
    .select(ACUITY_SELECT)
    .eq("partner_patient_id", id)
    .maybeSingle()) as { data: AcuityRow | null; error: { message: string } | null };
}

async function conflictWithLatest(db: AcuityDb, id: string): Promise<SetPatientAcuityResult> {
  const { data, error } = await readCurrent(db, id);
  return { ok: false, conflict: true, error: CONFLICT, entry: error ? undefined : toAcuityEntry(data) };
}

export async function applyAcuityChange(
  db: AcuityDb,
  userId: string,
  input: SetPatientAcuityInput,
  deps: { now?: () => Date } = {},
): Promise<SetPatientAcuityResult> {
  const id = input.partner_patient_id;
  const now = deps.now ?? (() => new Date());
  if (input.expected_updated_at === undefined) {
    return { ok: false, error: "Reload the level of care and try again — nothing was changed." };
  }
  const expected = input.expected_updated_at;
  const { data: existing, error: readErr } = await readCurrent(db, id);
  if (readErr) {
    return { ok: false, error: "Could not read the current level of care — nothing was changed. Try again." };
  }

  if (expected === null) {
    // Creation: only valid while no row exists.
    if (existing) return { ok: false, conflict: true, error: CONFLICT, entry: toAcuityEntry(existing) };
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
        updated_by: userId,
        updated_at: nextRevisionStamp(now(), null),
      })
      .select(ACUITY_SELECT)
      .maybeSingle();
    if (error) {
      if (error.code === "23505") return conflictWithLatest(db, id); // someone created it first
      return { ok: false, error: "Could not save the level of care." };
    }
    return { ok: true, entry: toAcuityEntry(row as AcuityRow) };
  }

  // Existing-row change: the row must still be at the revision the user saw.
  if (!existing) return { ok: false, conflict: true, error: CONFLICT, entry: null };
  // Exact string identity (fail-closed early exit); the DB CAS below is
  // still the authoritative check at full precision.
  if (existing.updated_at !== expected) return { ok: false, conflict: true, error: CONFLICT, entry: toAcuityEntry(existing) };

  const patch: Record<string, unknown> = {
    updated_by: userId,
    // Strictly after the expected revision, so it can never match again.
    updated_at: nextRevisionStamp(now(), expected),
  };
  if (input.level !== undefined) {
    if (input.level === null) patch.level_recorded = false;
    else {
      patch.level = input.level;
      patch.level_recorded = true;
    }
  }
  if (input.one_to_one !== undefined) patch.one_to_one = input.one_to_one;
  // Merge is computed from the freshly read row; the CAS below guarantees
  // it is the same version as `expected` or the write does not happen.
  const nextRecorded = (patch.level_recorded as boolean | undefined) ?? existing.level_recorded !== false;
  const nextOne = (patch.one_to_one as boolean | undefined) ?? existing.one_to_one === true;

  if (!nextRecorded && !nextOne) {
    const { data: gone, error } = await db
      .from(TABLE)
      .delete()
      .eq("partner_patient_id", id)
      .eq("updated_at", expected)
      .select("partner_patient_id");
    if (error) return { ok: false, error: "Could not clear the level of care." };
    if (!gone || (gone as unknown[]).length === 0) return conflictWithLatest(db, id);
    return { ok: true, entry: null };
  }

  const { data: rows, error } = await db
    .from(TABLE)
    .update(patch)
    .eq("partner_patient_id", id)
    .eq("updated_at", expected)
    .select(ACUITY_SELECT);
  if (error) return { ok: false, error: "Could not save the level of care." };
  if (!rows || (rows as unknown[]).length === 0) return conflictWithLatest(db, id);
  return { ok: true, entry: toAcuityEntry((rows as AcuityRow[])[0]) };
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
