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
  // Wardable state goes ONLY through the fenced POST /patients/wardable.
  for (const k of ["id", "expected_updated_at", "full_name", "wardable", "wardable_at", "wardable_by", "desired_revision"]) {
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

// ---------------------------------------------------------------------------
// Fenced wardable update: POST /patients/wardable (agreed contract).
//   body { id, expected_updated_at, wardable, desired_revision: "<bigint>" }
//   200 { ok:true, status:'applied'|'already_applied', desired_revision,
//         patient:{ id, wardable, wardable_at, updated_at } }
//   409 { ok:false, code:'superseded'|'revision_conflict'|'intent_conflict'|'target_changed',
//         desired_revision }
// The Hub reserves the latest desired revision per patient and rejects
// older ones, so a delayed older push can never overwrite a newer toggle.
// There is deliberately NO fallback to the generic patient POST.
// ---------------------------------------------------------------------------

const REVISION_RE = /^[1-9]\d{0,18}$/;
export const isDesiredRevision = (v: unknown): v is string => typeof v === "string" && REVISION_RE.test(v);

export type HubWardableConflict = "superseded" | "revision_conflict" | "intent_conflict" | "target_changed";

export type HubWardableOutcome =
  | {
      kind: "applied" | "already_applied";
      desired_revision: string;
      patient: { id: string; wardable: boolean; wardable_at: string | null; updated_at: string };
    }
  | { kind: "conflict"; code: HubWardableConflict; desired_revision: string }
  | { kind: "forbidden" }
  | { kind: "endpoint_unavailable" }
  | { kind: "unavailable"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "not_configured"; message: string };

const CONFLICT_CODES: readonly HubWardableConflict[] = ["superseded", "revision_conflict", "intent_conflict", "target_changed"];

export async function postHubWardable(
  req: { id: string; expected_updated_at: string; wardable: boolean; desired_revision: string },
  actor: HubActor,
  deps: HubDeps = {},
): Promise<HubWardableOutcome> {
  if (!isUuid(req.id)) return { kind: "invalid", message: "patient id must be a UUID" };
  if (!isDesiredRevision(req.desired_revision)) return { kind: "invalid", message: "desired revision must be a positive integer string" };
  if (typeof req.wardable !== "boolean") return { kind: "invalid", message: "wardable must be boolean" };
  if (!req.expected_updated_at || !Number.isFinite(Date.parse(req.expected_updated_at))) {
    return { kind: "invalid", message: "expected_updated_at is required" };
  }
  const r = await hubRequest(
    {
      method: "POST",
      path: "/patients/wardable",
      body: {
        id: req.id,
        expected_updated_at: req.expected_updated_at,
        wardable: req.wardable,
        desired_revision: req.desired_revision,
      },
      actor,
    },
    deps,
  );
  if (r.kind === "not_configured") return r;
  if (r.kind === "timeout" || r.kind === "network") return { kind: "unavailable", message: r.message };
  if (r.kind === "invalid_json") return { kind: "invalid", message: "ICU Handover Hub returned an unreadable response" };
  if (r.kind === "http_error") {
    if (r.status === 409) {
      const b = r.json as { ok?: unknown; code?: unknown; desired_revision?: unknown } | null;
      if (
        b &&
        b.ok === false &&
        CONFLICT_CODES.includes(b.code as HubWardableConflict) &&
        b.desired_revision === req.desired_revision
      ) {
        return { kind: "conflict", code: b.code as HubWardableConflict, desired_revision: req.desired_revision };
      }
      return { kind: "invalid", message: "ICU Handover Hub returned an unrecognised conflict" };
    }
    // Missing endpoint (Hub not yet upgraded): fail closed, never fall back.
    if (r.status === 404 || r.status === 405 || r.status === 501) return { kind: "endpoint_unavailable" };
    if (r.status === 401 || r.status === 403) return { kind: "forbidden" };
    return { kind: "unavailable", message: `ICU Handover Hub returned HTTP ${r.status}` };
  }
  const b = r.json as {
    ok?: unknown;
    status?: unknown;
    desired_revision?: unknown;
    patient?: { id?: unknown; wardable?: unknown; wardable_at?: unknown; updated_at?: unknown } | null;
  } | null;
  const p = b?.patient;
  if (
    !b ||
    b.ok !== true ||
    (b.status !== "applied" && b.status !== "already_applied") ||
    b.desired_revision !== req.desired_revision ||
    !p ||
    p.id !== req.id ||
    typeof p.wardable !== "boolean" ||
    !(p.wardable_at === null || (typeof p.wardable_at === "string" && Number.isFinite(Date.parse(p.wardable_at)))) ||
    typeof p.updated_at !== "string" ||
    !Number.isFinite(Date.parse(p.updated_at))
  ) {
    return { kind: "invalid", message: "ICU Handover Hub returned an unexpected wardable response" };
  }
  if (p.wardable !== req.wardable) {
    // A success that doesn't match what we asked for is not a success.
    return { kind: "invalid", message: "ICU Handover Hub reported a different wardable state" };
  }
  return {
    kind: b.status,
    desired_revision: req.desired_revision,
    patient: { id: p.id, wardable: p.wardable, wardable_at: (p.wardable_at as string | null) ?? null, updated_at: p.updated_at },
  };
}
