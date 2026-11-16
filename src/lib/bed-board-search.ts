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
  const out: BedBoardSearch = {};
  if (s.focus_shift === "day" || s.focus_shift === "night") out.focus_shift = s.focus_shift;
  const lvl = Number(s.focus_level);
  if (lvl === 1 || lvl === 2 || lvl === 3) out.focus_level = lvl;
  const ref = uuidOrUndefined(s.source_referral_id);
  if (ref) out.source_referral_id = ref;
  const post = uuidOrUndefined(s.source_postop_booking_id);
  if (post) out.source_postop_booking_id = post;
  if (
    (ref || post) &&
    typeof s.source_label === "string" &&
    (BED_BOARD_SOURCE_LABELS as readonly string[]).includes(s.source_label)
  ) {
    out.source_label = s.source_label as BedBoardSourceLabel;
  }
  return out;
}

export function hasLegacyIdentifierParams(params: URLSearchParams): boolean {
  if (LEGACY_IDENTIFIER_PARAMS.some((k) => params.has(k))) return true;
  const label = params.get("source_label");
  // Old labels embedded the hospital number, e.g. "referral 1234567".
  return label !== null && !(BED_BOARD_SOURCE_LABELS as readonly string[]).includes(label.replace(/^"|"$/g, ""));
}
