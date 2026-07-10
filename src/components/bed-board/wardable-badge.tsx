/**
 * Shared "Wardable" indicator used on both the interactive bed board and
 * the TV board. Keeping the styling in one place guarantees that the same
 * clinical state always looks identical across surfaces.
 */
export function WardableBadge({ className = "" }: { className?: string }) {
  return (
    <span
      className={
        "inline-flex items-center rounded border px-1.5 py-0.5 font-semibold uppercase tracking-wide " +
        "bg-emerald-500/10 text-emerald-700 border-emerald-500/30 " +
        "dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-400/40 " +
        className
      }
      title="Wardable — ready for a ward bed"
      aria-label="Wardable"
    >
      Wardable
    </span>
  );
}
