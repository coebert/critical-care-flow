import { z } from "zod";

/**
 * Convert any free-text value into a compact initials string.
 *
 * Rules:
 * - Splits on whitespace, dots, hyphens, commas and apostrophes.
 * - Takes the first letter of each token, uppercases it.
 * - Drops anything that isn't a letter (digits, punctuation, symbols).
 * - Caps the result at 10 characters.
 *
 * Examples:
 *   "John Smith"   -> "JS"
 *   "j.smith"      -> "JS"
 *   "Mary-Jane O'Neill" -> "MJO"
 *   "JS"           -> "JS"
 *   "  "           -> ""
 */
export function toInitials(input: string | null | undefined): string {
  if (!input) return "";
  const cleaned = input.normalize("NFKD").replace(/[^\p{L}\s.\-',]/gu, " ");
  const tokens = cleaned.split(/[\s.\-',]+/).filter(Boolean);
  const letters = tokens
    .map((t) => t[0])
    .filter((c) => /\p{L}/u.test(c))
    .map((c) => c.toUpperCase())
    .join("");
  return letters.slice(0, 10);
}

/**
 * True when the raw input already matches strict initials
 * (1–10 uppercase Latin letters, nothing else).
 */
export function isStrictInitials(value: string): boolean {
  return /^[A-Z]{1,10}$/.test(value);
}

/**
 * Zod schema for a patient_initials field on server functions.
 *
 * Accepts nullable/optional input and always normalises to initials
 * before the value reaches the database. Guarantees that no
 * accidental full name is ever persisted.
 */
export const patientInitialsField = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => {
    if (v == null) return null;
    const normalized = toInitials(v);
    return normalized.length ? normalized : null;
  })
  .refine(
    (v) => v == null || /^[A-Z]{1,10}$/.test(v),
    { message: "Initials must be 1–10 letters" },
  );
