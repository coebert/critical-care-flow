import { describe, expect, it } from "vitest";
import { safeInternalRedirect } from "./safe-redirect";

describe("safeInternalRedirect", () => {
  it.each([
    "/bed-board",
    "/referrals/00000000-0000-4000-8000-000000000009?tab=notes",
    "/board/ward-round#top",
    "/analytics?view=postop",
  ])("keeps internal deep link %s", (p) => {
    expect(safeInternalRedirect(p)).toBe(p);
  });

  it.each([
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/\\/evil.example",
    "\\\\evil.example",
    "/%5Cevil.example",
    "/%2F%2Fevil.example",
    "/%2f/evil.example",
    "/%252F%252Fevil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r\n//evil.example",
    "/%09/evil.example",
    "/%0a/evil.example",
    "/\u0000x",
    "/\u007fx",
    " /evil",
    "javascript:alert(1)",
    "data:text/html,x",
    "evil.example",
    "",
    "/%E0%A4%A",
    "/auth",
    "/auth?redirect=/x",
  ])("rejects %j", (p) => {
    expect(safeInternalRedirect(p)).toBeNull();
  });

  it("rejects non-strings and oversize input", () => {
    expect(safeInternalRedirect(undefined)).toBeNull();
    expect(safeInternalRedirect(["/x"])).toBeNull();
    expect(safeInternalRedirect("/" + "a".repeat(5000))).toBeNull();
  });
});
