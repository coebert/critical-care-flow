import { describe, it, expect } from "vitest";
import { friendlyE2EError } from "@/lib/friendly-e2e-error";

describe("note delete error wording", () => {
  it("a delete that changed nothing is reported as a failed delete, with the reason", () => {
    const f = friendlyE2EError(new Error("Note was not deleted — it may already be gone, or your access has changed."), "delete-note");
    expect(f.title).toBe("Couldn't delete note");
    expect(f.description).toContain("your access has changed");
  });
});
