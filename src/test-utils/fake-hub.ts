/**
 * Synthetic in-memory ICU Handover Hub for tests. Implements only the two
 * patient endpoints CCC uses: GET /patients?id=<uuid> and a partial,
 * revision-checked POST /patients. No network, no real data.
 */
export type FakeHubCall = {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
};

export function fakeHub(patients: Array<Record<string, unknown> & { id: string }>) {
  const store = new Map<string, Record<string, unknown> & { id: string; updated_at: string }>(
    patients.map((p) => [p.id, { updated_at: "2026-11-16T10:00:00.000Z", ...p } as Record<string, unknown> & { id: string; updated_at: string }]),
  );
  const shared = new Set(store.keys());
  const calls: FakeHubCall[] = [];
  let rev = 0;
  const control = {
    down: false,
    /** Called just before a POST is applied (simulate a concurrent edit). */
    beforePost: null as null | (() => void),
    hang: false,
  };
  const bump = (id: string, patch: Record<string, unknown>) => {
    rev += 1;
    const cur = store.get(id)!;
    store.set(id, { ...cur, ...patch, id, updated_at: new Date(Date.parse("2026-11-16T10:00:00.000Z") + rev * 1000).toISOString() });
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method: init?.method ?? "GET", url, headers, body });
    if (control.hang) {
      return new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
      });
    }
    if (control.down) return json(503, { error: "down" });
    if (!url.pathname.endsWith("/patients")) return json(404, { error: "not found" });
    if ((init?.method ?? "GET") === "GET") {
      const id = url.searchParams.get("id");
      const p = id && shared.has(id) ? store.get(id) : undefined;
      return json(200, { patients: p ? [p] : [] });
    }
    const id = String(body?.id ?? "");
    if (!shared.has(id) || !store.has(id)) return json(404, { error: "not_found" });
    const hook = control.beforePost;
    control.beforePost = null;
    hook?.();
    const cur = store.get(id)!;
    if (!body?.expected_updated_at) return json(400, { error: "expected_updated_at_required" });
    if (body.expected_updated_at !== cur.updated_at) return json(409, { error: "concurrent_modification" });
    const { id: _i, expected_updated_at: _e, ...patch } = body;
    bump(id, patch);
    return json(200, { patient: store.get(id) });
  }) as typeof fetch;

  return {
    fetchImpl,
    calls,
    control,
    store,
    unshare: (id: string) => shared.delete(id),
    /** Simulate someone else editing the Hub patient. */
    externalEdit: (id: string, patch: Record<string, unknown>) => bump(id, patch),
    deps: { fetchImpl, baseUrl: "https://hub.synthetic.test/api/public/bridge", secret: "synthetic-secret", timeoutMs: 50 },
  };
}
