import { toInitials } from "./patient-initials";

/**
 * Normalise an incoming bridge record so we never overwrite our stored
 * patient identifier with a full name.
 *
 * The partner app models the patient identifier on the `patients` table as
 * `full_name` (we reuse it as the initials carrier — see `bed-board.tsx`).
 * Bed occupancies and outliers use `patient_initials` directly. On both
 * paths the partner or an older client may still send a real name; we
 * strip it down to initials before writing, and clear the value if
 * nothing letter-shaped remains.
 *
 * This is safe to call on any incoming record — resources without a
 * patient identifier field are passed through untouched.
 */
export function normalizeIncomingBridgeRecord(
  key: string,
  record: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...record };

  const normaliseField = (field: string) => {
    if (!(field in out)) return;
    const raw = out[field];
    if (raw == null || raw === "") {
      out[field] = null;
      return;
    }
    if (typeof raw !== "string") return;
    const initials = toInitials(raw);
    out[field] = initials.length ? initials : null;
  };

  if (key === "patients") {
    // Newer wire format sends `patient_initials`; our local column is
    // `full_name` (reused as the initials carrier). Fold the wire field
    // into `full_name` before normalising, then drop it so it never
    // reaches the DB as an unknown column.
    if ("patient_initials" in out) {
      const pi = out.patient_initials;
      if (pi != null && pi !== "" && (out.full_name == null || out.full_name === "")) {
        out.full_name = pi;
      }
      delete out.patient_initials;
    }
    normaliseField("full_name");
  }
  if (key === "bed_occupancies" || key === "bed_outliers") {
    normaliseField("patient_initials");
  }

  return out;
}
