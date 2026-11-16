// @vitest-environment jsdom
/** Mounted: a note delete the server refuses shows a "Couldn't delete note" toast, not an edit error. */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { toast } = vi.hoisted(() => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn, createServerFn: () => { const b: any = { middleware: () => b, inputValidator: () => b, handler: () => vi.fn() }; return b; } }));
vi.mock("@/lib/referrals.functions", () => ({ getNoteHistory: vi.fn() }));

import { NoteItem, type Note } from "@/components/note-item";

const USER = "11111111-1111-4111-8111-111111111111";
const note = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", referral_id: "r", author_id: USER, body: "Synthetic note",
  created_at: "2026-11-16T10:00:00Z", updated_at: "2026-11-16T10:00:00Z", edited_at: null, _e2eStatus: "plaintext",
} as unknown as Note;

describe("NoteItem delete failure", () => {
  it("shows the delete-specific message with the server's reason", async () => {
    const onDelete = vi.fn(async () => { throw new Error("Note was not deleted — it may already be gone, or your access has changed."); });
    render(<NoteItem note={note} authorName="SP" authorMap={{}} directory={[]} currentUserId={USER} canEdit onSave={vi.fn()} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete note" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const [title, opts] = toast.error.mock.calls[0] as [string, { description: string }];
    expect(title).toBe("Couldn't delete note");
    expect(opts.description).toContain("your access has changed");
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
