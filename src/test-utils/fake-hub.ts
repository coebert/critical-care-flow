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
    /** Hub not yet upgraded: POST /patients/wardable → 404. */
    noWardableEndpoint: false,
    /** Called when a wardable POST arrives, before the fence is evaluated. */
    beforeWardable: null as null | ((body: Record<string, unknown>) => void | Promise<void>),
    /** Hold wardable POST responses until released (out-of-order tests). */
    holdWardableResponse: null as null | Promise<void>,
    /** Reject an exactly replayed signed request (same timestamp+signature) with 401. */
    rejectReplays: false,
  };
  /** Hub-side fence per patient: latest reserved revision + intent + applied. */
  const fence = new Map<string, { reserved: bigint; wardable: boolean; applied: boolean }>();
  const audit: Array<{ id: string; revision: string; result: string }> = [];
  const seenSignatures = new Set<string>();
  const bump = (id: string, patch: Record<string, unknown>) => {
    rev += 1;
    const cur = store.get(id)!;
    store.set(id, { ...cur, ...patch, id, updated_at: new Date(Date.parse("2026-11-16T10:00:00.000Z") + rev * 1000).toISOString() });
  };
  /** Agreed contract semantics for POST /patients/wardable. */
  const wardable = (b: Record<string, unknown>): { status: number; body: Record<string, unknown> } => {
    const id = String(b.id ?? "");
    const revRaw = String(b.desired_revision ?? "");
    if (!/^[1-9]\d*$/.test(revRaw) || typeof b.wardable !== "boolean" || typeof b.expected_updated_at !== "string") {
      return { status: 400, body: { ok: false, error: "invalid_request" } };
    }
    const rev = BigInt(revRaw);
    const want = b.wardable;
    // Hub contract: conflicts report the Hub's HIGHEST reserved revision
    // (for superseded that is greater than the request).
    const conflict = (code: string, reported: bigint = rev) => ({
      status: 409,
      body: { ok: false, code, desired_revision: reported.toString() },
    });
    // Opaque 404 for absent / unshared / revoked / other-unit patients.
    if (!shared.has(id) || !store.has(id)) return { status: 404, body: { ok: false, code: "not_found" } };
    const cur = store.get(id)!;
    const f = fence.get(id);
    const apply = (status: "applied" | "already_applied") => {
      if (status === "applied") {
        bump(id, { wardable: want, wardable_at: want ? "2026-11-16T12:00:00.000Z" : null });
      }
      fence.set(id, { reserved: rev, wardable: want, applied: true });
      const p = store.get(id)!;
      return { status: 200, body: { ok: true, status, desired_revision: revRaw, patient: { id, wardable: p.wardable, wardable_at: p.wardable_at ?? null, updated_at: p.updated_at } } };
    };
    if (f && rev < f.reserved) return conflict("superseded", f.reserved);
    if (f && rev === f.reserved) {
      if (f.wardable !== want) return conflict("intent_conflict");
      if (f.applied) return cur.wardable === want ? apply("already_applied") : conflict("target_changed");
      if (b.expected_updated_at !== cur.updated_at) return conflict("revision_conflict");
      return apply("applied");
    }
    // Newer revision: reserve it even if the CAS then fails.
    fence.set(id, { reserved: rev, wardable: want, applied: false });
    if (b.expected_updated_at !== cur.updated_at) return conflict("revision_conflict");
    return apply("applied");
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
    if (url.pathname.endsWith("/patients/wardable") && (init?.method ?? "GET") === "POST") {
      if (control.noWardableEndpoint) return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain" } });
      if (control.rejectReplays) {
        const nonce = `${headers["x-timestamp"]}:${headers["x-signature"]}`;
        if (seenSignatures.has(nonce)) return json(401, { ok: false, error: "replayed request" });
        seenSignatures.add(nonce);
      }
      if (control.beforeWardable) {
        const h = control.beforeWardable;
        control.beforeWardable = null;
        await h(body ?? {});
      }
      const resp = wardable(body ?? {});
      audit.push({ id: String(body?.id), revision: String(body?.desired_revision), result: String((resp.body as any).status ?? (resp.body as any).code) });
      if (control.holdWardableResponse) await control.holdWardableResponse;
      return json(resp.status, resp.body);
    }
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
    fence,
    audit,
    unshare: (id: string) => shared.delete(id),
    /** Simulate someone else editing the Hub patient. */
    externalEdit: (id: string, patch: Record<string, unknown>) => bump(id, patch),
    deps: { fetchImpl, baseUrl: "https://hub.synthetic.test/api/public/bridge", secret: "synthetic-secret", timeoutMs: 50 },
  };
}
