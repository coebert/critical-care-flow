import { format } from "date-fns";

/**
 * Returns a tooltip string for a timestamp, disclosing the user's timezone
 * and the raw ISO value so operators can confirm no UTC/local mismatch.
 *
 * All formatted timestamps in the UI render in the user's local browser
 * timezone (via `new Date(iso)` + date-fns `format`). This helper makes
 * that explicit on hover.
 */
export function tzTooltip(iso: string | number | Date): string {
  try {
    const d = iso instanceof Date ? iso : new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const tz =
      Intl.DateTimeFormat().resolvedOptions().timeZone || "your local timezone";
    // Short zone name like "GMT" / "BST" / "EST"
    const shortName =
      new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
        .formatToParts(d)
        .find((p) => p.type === "timeZoneName")?.value ?? "";
    const local = format(d, "dd/MM/yyyy HH:mm:ss");
    const utc = d.toISOString();
    return `${local} ${shortName} — local time (${tz})\nUTC: ${utc}`;
  } catch {
    return String(iso);
  }
}
