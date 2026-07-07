import { describe, it, expect } from "vitest";
import { isOverdue, nextTaskStatus } from "./referral-tasks";

describe("referral-tasks", () => {
  const now = new Date("2026-01-15T12:00:00Z");
  it("open + past due → overdue", () => {
    expect(isOverdue("2026-01-15T11:59:00Z", "open", now)).toBe(true);
  });
  it("open + future due → not overdue", () => {
    expect(isOverdue("2026-01-15T13:00:00Z", "open", now)).toBe(false);
  });
  it("done + past due → not overdue", () => {
    expect(isOverdue("2026-01-14T00:00:00Z", "done", now)).toBe(false);
  });
  it("no due date → not overdue", () => {
    expect(isOverdue(null, "open", now)).toBe(false);
  });
  it("status transitions", () => {
    expect(nextTaskStatus("open", "complete")).toBe("done");
    expect(nextTaskStatus("done", "reopen")).toBe("open");
    expect(nextTaskStatus("open", "cancel")).toBe("cancelled");
  });
});
