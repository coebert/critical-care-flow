// Server-only: one signed, time-bounded HTTP client for ICU Handover Hub.
//
// Every CCC → Hub request goes through `hubRequest` so it gets the same
// HMAC envelope, a bounded timeout, and a typed outcome. Response bodies are
// never logged (they may hold clinical data); only status codes and failure
// classes are.

import { createHmac } from "node:crypto";

export const HUB_TIMEOUT_MS = 8_000;

export type HubActor = { id: string; email?: string; role: "admin" | "clinician" | "system" };

export type HubDeps = {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  secret?: string;
  timeoutMs?: number;
  nowSeconds?: () => number;
};

export type HubResponse =
  | { kind: "ok"; status: number; json: unknown }
  | { kind: "http_error"; status: number; json: unknown; text: string }
  | { kind: "timeout"; message: string }
  | { kind: "network"; message: string }
  | { kind: "invalid_json"; status: number }
  | { kind: "not_configured"; message: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

async function resolveConfig(deps: HubDeps): Promise<{ base: string; secret: string } | { error: string }> {
  const base = deps.baseUrl ?? process.env.PARTNER_BRIDGE_URL;
  if (!base) return { error: "PARTNER_BRIDGE_URL is not configured" };
  let secret = deps.secret;
  if (!secret) {
    try {
      const { getBridgeSecrets } = await import("./bridge-hmac.server");
      secret = getBridgeSecrets().current;
    } catch (err) {
      return { error: (err as Error).message };
    }
  }
  return { base: base.replace(/\/$/, ""), secret };
}

export async function hubRequest(
  req: {
    method: "GET" | "POST";
    path: string;
    query?: Record<string, string>;
    body?: Record<string, unknown>;
    actor: HubActor;
  },
  deps: HubDeps = {},
): Promise<HubResponse> {
  const cfg = await resolveConfig(deps);
  if ("error" in cfg) return { kind: "not_configured", message: cfg.error };
  const actor = JSON.stringify(req.actor);
  const rawBody = req.method === "GET" ? "" : JSON.stringify(req.body ?? {});
  const ts = String(deps.nowSeconds ? deps.nowSeconds() : Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", cfg.secret).update(`${ts}.${actor}.${rawBody}`).digest("hex");
  const qs = req.query ? `?${new URLSearchParams(req.query).toString()}` : "";
  const url = `${cfg.base}${req.path}${qs}`;
  const doFetch = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutMs = deps.timeoutMs ?? HUB_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let res: Response;
  try {
    res = await doFetch(url, {
      method: req.method,
      headers: {
        ...(req.method === "POST" ? { "content-type": "application/json" } : {}),
        "x-timestamp": ts,
        "x-actor": actor,
        "x-signature": signature,
        "cache-control": "no-store",
      },
      body: req.method === "POST" ? rawBody : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (timedOut) return { kind: "timeout", message: `ICU Handover Hub did not respond within ${Math.round(timeoutMs / 1000)}s` };
    return { kind: "network", message: "ICU Handover Hub could not be reached" };
  }
  let text = "";
  try {
    text = await res.text();
  } catch {
    clearTimeout(timer);
    if (timedOut) return { kind: "timeout", message: `ICU Handover Hub did not respond within ${Math.round(timeoutMs / 1000)}s` };
    return { kind: "network", message: "ICU Handover Hub response was interrupted" };
  }
  clearTimeout(timer);
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      if (res.ok) return { kind: "invalid_json", status: res.status };
    }
  }
  if (!res.ok) return { kind: "http_error", status: res.status, json, text: text.slice(0, 512) };
  return { kind: "ok", status: res.status, json };
}

// ---------------------------------------------------------------------------
// Narrow identity read: GET /patients?id=<uuid> → { patients: [target] }.
// The Hub scopes this to Radnor + shared patients; an empty list means the
// patient is not (or no longer) shared with CCC.
// ---------------------------------------------------------------------------

export type HubPatient = Record<string, unknown> & { id: string; updated_at: string };

export type HubPatientRead =
  | { kind: "ok"; patient: HubPatient }
  | { kind: "not_shared" }
  | { kind: "forbidden" }
  | { kind: "unavailable"; message: string }
  | { kind: "not_configured"; message: string }
  | { kind: "invalid"; message: string };

export async function fetchHubPatient(id: string, actor: HubActor, deps: HubDeps = {}): Promise<HubPatientRead> {
  if (!isUuid(id)) return { kind: "invalid", message: "patient id must be a UUID" };
  const r = await hubRequest({ method: "GET", path: "/patients", query: { id }, actor }, deps);
  if (r.kind === "not_configured") return r;
  if (r.kind === "timeout" || r.kind === "network") return { kind: "unavailable", message: r.message };
  if (r.kind === "invalid_json") return { kind: "invalid", message: "ICU Handover Hub returned an unreadable response" };
  if (r.kind === "http_error") {
    if (r.status === 404) return { kind: "not_shared" };
    if (r.status === 401 || r.status === 403) return { kind: "forbidden" };
    return { kind: "unavailable", message: `ICU Handover Hub returned HTTP ${r.status}` };
  }
  const body = r.json as { patients?: unknown } | null;
  if (!body || !Array.isArray(body.patients)) return { kind: "invalid", message: "Hub patient response missing patients array" };
  if (body.patients.length === 0) return { kind: "not_shared" };
  if (body.patients.length !== 1) return { kind: "invalid", message: "Hub returned more than one patient for an id lookup" };
  const p = body.patients[0] as Record<string, unknown> | null;
  if (!p || typeof p !== "object" || p.id !== id) return { kind: "invalid", message: "Hub returned a different patient than requested" };
  if (typeof p.updated_at !== "string" || !Number.isFinite(Date.parse(p.updated_at))) {
    return { kind: "invalid", message: "Hub patient has no revision (updated_at)" };
  }
  return { kind: "ok", patient: p as HubPatient };
}

// ---------------------------------------------------------------------------
// Partial, revision-checked patient update. `expected_updated_at` is
// mandatory so the Hub can apply an atomic compare-and-set.
// ---------------------------------------------------------------------------

export type HubPatchOutcome =
  | { kind: "ok"; updated_at: string | null }
  | { kind: "conflict" }
  | { kind: "not_shared" }
  | { kind: "forbidden" }
  | { kind: "rejected"; status: number }
  | { kind: "unavailable"; message: string }
  | { kind: "not_configured"; message: string };

export async function patchHubPatient(
  id: string,
  expectedUpdatedAt: string,
  patch: Record<string, unknown>,
  actor: HubActor,
  deps: HubDeps = {},
): Promise<HubPatchOutcome> {
  if (!isUuid(id)) return { kind: "rejected", status: 400 };
  if (!expectedUpdatedAt) return { kind: "rejected", status: 400 };
  for (const k of ["id", "expected_updated_at", "full_name"]) {
    if (k in patch) return { kind: "rejected", status: 400 };
  }
  const r = await hubRequest(
    { method: "POST", path: "/patients", body: { id, expected_updated_at: expectedUpdatedAt, ...patch }, actor },
    deps,
  );
  if (r.kind === "not_configured") return r;
  if (r.kind === "timeout" || r.kind === "network") return { kind: "unavailable", message: r.message };
  if (r.kind === "invalid_json") return { kind: "unavailable", message: "ICU Handover Hub returned an unreadable response" };
  if (r.kind === "http_error") {
    if (r.status === 409) return { kind: "conflict" };
    if (r.status === 404) return { kind: "not_shared" };
    if (r.status === 401 || r.status === 403) return { kind: "forbidden" };
    if (r.status >= 500 || r.status === 408 || r.status === 429) {
      return { kind: "unavailable", message: `ICU Handover Hub returned HTTP ${r.status}` };
    }
    return { kind: "rejected", status: r.status };
  }
  const p = (r.json as { patient?: { updated_at?: unknown } } | null)?.patient;
  return { kind: "ok", updated_at: typeof p?.updated_at === "string" ? p.updated_at : null };
}

export function actorFor(userId: string, claims: Record<string, unknown> | undefined): HubActor {
  const email = claims && typeof claims.email === "string" ? claims.email : undefined;
  return { id: userId, email, role: "clinician" };
}
