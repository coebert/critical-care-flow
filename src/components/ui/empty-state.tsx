import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}

/**
 * A shared empty-state block: soft icon, one-line message, optional
 * next-step action. Used wherever a data surface (list, table, panel)
 * has no rows to show. Keeps the visual pause consistent across screens.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col items-center justify-center text-center gap-2",
        compact ? "py-6 px-4" : "py-10 px-4",
        className,
      )}
    >
      {Icon && (
        <Icon
          className={cn(
            "text-muted-foreground/60 mb-1",
            compact ? "w-5 h-5" : "w-8 h-8",
          )}
          aria-hidden="true"
        />
      )}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && (
        <p className="text-xs text-muted-foreground max-w-sm">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
