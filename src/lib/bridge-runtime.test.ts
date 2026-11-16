import { describe, it, expect } from "vitest";
import { classifyBridgeHost } from "@/lib/bridge-runtime";

const ID = "a8eeeba1-1944-4344-93c0-4f9de4184412";

describe("classifyBridgeHost", () => {
  it.each([
    ["critical-care-flow.lovable.app", "published"],
    [`project--${ID}.lovable.app`, "published"],
    [`project--${ID}-dev.lovable.app`, "preview"],
    [`id-preview--${ID}.lovable.app`, "preview"],
    ["localhost:8080", "local"],
    ["evil.example", "unknown"],
  ])("%s → %s", (host, expected) => {
    expect(classifyBridgeHost(host)).toBe(expected);
  });
});
