/**
 * Bed Board URL search params. Only opaque ids and a neutral label are
 * accepted. Patient identifiers (hospital number, initials, consultant,
 * level) used to be passed in the query string — they leak into browser
 * history, proxies and analytics, so they are now ignored and stripped.
 */
export type BedBoardSearch = {
  focus_shift?: "day" | "night";
  focus_level?: 1 | 2 | 3;
  source_referral_id?: string;
  source_postop_booking_id?: string;
  source_label?: BedBoardSourceLabel;
  // Legacy identifier params are always present as `undefined` so they
  // overwrite the raw values TanStack Router passes through from the URL.
  hospital_number?: undefined;
  patient_initials?: undefined;
  admitting_consultant?: undefined;
  level?: undefined;
};

export const BED_BOARD_SOURCE_LABELS = ["referral", "post-op booking"] as const;
export type BedBoardSourceLabel = (typeof BED_BOARD_SOURCE_LABELS)[number];

/** Params older links carried that must never be read or kept. */
export const LEGACY_IDENTIFIER_PARAMS = [
  "hospital_number",
  "patient_initials",
  "admitting_consultant",
  "level",
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidOrUndefined(v: unknown): string | undefined {
  return typeof v === "string" && UUID_RE.test(v) ? v : undefined;
}

export function parseBedBoardSearch(s: Record<string, unknown>): BedBoardSearch {
  // Every key is set explicitly (possibly to undefined): the router merges
  // the raw URL search underneath the validated result, so an omitted key
  // would let an unvalidated value (e.g. "referral 1234567") leak through.
  const lvl = Number(s.focus_level);
  const ref = uuidOrUndefined(s.source_referral_id);
  const post = uuidOrUndefined(s.source_postop_booking_id);
  const label =
    (ref || post) &&
    typeof s.source_label === "string" &&
    (BED_BOARD_SOURCE_LABELS as readonly string[]).includes(s.source_label)
      ? (s.source_label as BedBoardSourceLabel)
      : undefined;
  return {
    focus_shift: s.focus_shift === "day" || s.focus_shift === "night" ? s.focus_shift : undefined,
    focus_level: lvl === 1 || lvl === 2 || lvl === 3 ? lvl : undefined,
    source_referral_id: ref,
    source_postop_booking_id: post,
    source_label: label,
    hospital_number: undefined,
    patient_initials: undefined,
    admitting_consultant: undefined,
    level: undefined,
  };
}

export function hasLegacyIdentifierParams(params: URLSearchParams): boolean {
  if (LEGACY_IDENTIFIER_PARAMS.some((k) => params.has(k))) return true;
  const label = params.get("source_label");
  // Old labels embedded the hospital number, e.g. "referral 1234567".
  return label !== null && !(BED_BOARD_SOURCE_LABELS as readonly string[]).includes(label.replace(/^"|"$/g, ""));
}
