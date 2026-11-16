import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("hydration gate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("a cold-load guard waits for the client-only boundary to hydrate", async () => {
    const g = await import("./hydration-gate");
    let done = false;
    void g.afterHydration().then(() => (done = true));
    g.markShellHydrated();
    await vi.advanceTimersByTimeAsync(10);
    expect(done).toBe(false);
    g.markBoundaryHydrated();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it("never hangs if no boundary marker renders", async () => {
    const g = await import("./hydration-gate");
    let done = false;
    void g.afterHydration().then(() => (done = true));
    g.markShellHydrated();
    await vi.advanceTimersByTimeAsync(400);
    expect(done).toBe(true);
  });

  it("later client navigations do not wait", async () => {
    const g = await import("./hydration-gate");
    g.markShellHydrated();
    let done = false;
    void g.afterHydration().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
  });
});
