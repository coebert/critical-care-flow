/**
 * Post-op booking lifecycle — status enum, transition matrix, and helpers
 * shared between server functions, the planner, the cancellations register
 * and the edit form.
 */

export const POSTOP_BOOKING_STATUSES = [
  "requested",
  "provisionally_confirmed",
  "confirmed",
  "admitted",
  "cancelled",
] as const;

export type PostopBookingStatus = (typeof POSTOP_BOOKING_STATUSES)[number];

export const POSTOP_STATUS_LABEL: Record<PostopBookingStatus, string> = {
  requested: "Requested",
  provisionally_confirmed: "Provisional",
  confirmed: "Confirmed",
  admitted: "Admitted",
  cancelled: "Cancelled",
};

/** Tailwind classes for the status pill. */
export const POSTOP_STATUS_CLASS: Record<PostopBookingStatus, string> = {
  requested: "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100",
  provisionally_confirmed:
    "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100",
  confirmed:
    "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100",
  admitted:
    "bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-100",
  cancelled:
    "bg-rose-100 text-rose-900 dark:bg-rose-900/40 dark:text-rose-100",
};

export const POSTOP_CANCELLATION_REASONS = [
  "no_bed",
  "patient_unfit",
  "surgery_deferred",
  "died_pre_op",
  "other",
] as const;

export type PostopCancellationReason =
  (typeof POSTOP_CANCELLATION_REASONS)[number];

export const POSTOP_CANCELLATION_LABEL: Record<PostopCancellationReason, string> = {
  no_bed: "No bed available",
  patient_unfit: "Patient unfit",
  surgery_deferred: "Surgery deferred",
  died_pre_op: "Died pre-op",
  other: "Other",
};

/**
 * Valid forward transitions. Any status may go to `cancelled`.
 * `admitted` and `cancelled` are terminal (no forward transitions), but an
 * admin can still reopen via the raw update path.
 */
const TRANSITIONS: Record<PostopBookingStatus, PostopBookingStatus[]> = {
  requested: ["provisionally_confirmed", "confirmed", "admitted", "cancelled"],
  provisionally_confirmed: ["confirmed", "admitted", "cancelled"],
  confirmed: ["admitted", "cancelled"],
  admitted: [],
  cancelled: [],
};

export type TransitionContext = {
  preop_signed_off_at: string | null;
  intensivist_reviewed_at: string | null;
  cancellation_reason?: PostopCancellationReason | null;
};

export type TransitionDecision =
  | { ok: true }
  | { ok: false; reason: string };

export function canTransition(
  current: PostopBookingStatus,
  next: PostopBookingStatus,
  ctx: TransitionContext,
): TransitionDecision {
  if (current === next) return { ok: false, reason: "Already in that state" };
  const allowed = TRANSITIONS[current] ?? [];
  if (!allowed.includes(next)) {
    return { ok: false, reason: `Cannot move ${current} → ${next}` };
  }
  if (next === "confirmed") {
    if (!ctx.preop_signed_off_at || !ctx.intensivist_reviewed_at) {
      return {
        ok: false,
        reason:
          "Anaesthetic sign-off and intensivist review are both required before confirming.",
      };
    }
  }
  if (next === "cancelled" && !ctx.cancellation_reason) {
    return { ok: false, reason: "Select a cancellation reason." };
  }
  return { ok: true };
}

export function nextAllowedStatuses(
  current: PostopBookingStatus,
): PostopBookingStatus[] {
  return TRANSITIONS[current] ?? [];
}

/**
 * Auto-conversion of a post-op booking into a live referral is only
 * meaningful once the booking is confirmed and the surgery date has arrived
 * (or is imminent). Also blocks re-conversion.
 */
export function isEligibleForConversion(booking: {
  booking_status: PostopBookingStatus;
  proposed_surgery_date: string | null;
  converted_referral_id: string | null | undefined;
  deleted_at?: string | null;
}, today: Date = new Date()): boolean {
  if (booking.deleted_at) return false;
  if (booking.converted_referral_id) return false;
  if (!["confirmed", "provisionally_confirmed"].includes(booking.booking_status)) {
    return false;
  }
  if (!booking.proposed_surgery_date) return false;
  const surgery = new Date(booking.proposed_surgery_date + "T23:59:59");
  return surgery.getTime() >= today.getTime() - 24 * 3600 * 1000 &&
    new Date(booking.proposed_surgery_date + "T00:00:00").getTime() <=
      today.getTime() + 24 * 3600 * 1000;
}
