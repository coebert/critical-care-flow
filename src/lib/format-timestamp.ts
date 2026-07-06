/**
 * Returns a deterministic tooltip string for a timestamp, disclosing that
 * the visible value is rendered in the viewer's local browser timezone and
 * exposing the raw UTC value for cross-checks.
 *
 * Deterministic (no `Intl.DateTimeFormat` timezone lookup) so it renders
 * identically during SSR and client hydration — avoids hydration mismatch
 * warnings while still making the local-vs-UTC contract explicit on hover.
 */
export function tzTooltip(iso: string | number | Date): string {
  try {
    const d = iso instanceof Date ? iso : new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return `${d.toISOString()} (UTC)\nShown in your local browser timezone.`;
  } catch {
    return String(iso);
  }
}
