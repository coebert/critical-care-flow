export type TaskStatus = "open" | "done" | "cancelled";

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  open: "Open",
  done: "Done",
  cancelled: "Cancelled",
};

export function isOverdue(due_at: string | null | undefined, status: TaskStatus, now: Date = new Date()): boolean {
  if (status !== "open") return false;
  if (!due_at) return false;
  return new Date(due_at).getTime() < now.getTime();
}

export function nextTaskStatus(current: TaskStatus, action: "complete" | "reopen" | "cancel"): TaskStatus {
  if (action === "complete") return "done";
  if (action === "reopen") return "open";
  return "cancelled";
}
