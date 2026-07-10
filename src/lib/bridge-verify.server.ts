import { jsonResponse } from "./bridge-cors";
import {
  getBridgeSecrets,
  verifySignature,
  type BridgeActor,
} from "./bridge-hmac.server";
import { actorMayWrite, parseActorHeader } from "./bridge-actor";

export type VerifiedBridgeRequest = {
  actor: BridgeActor;
  rawBody: string;
  secretUsed: "current" | "previous";
};

/**
 * Verifies the HMAC signature + timestamp skew + actor of an inbound bridge
 * request. Returns the verified context on success, or a Response to return
 * directly on failure. Callers still perform per-resource RBAC after this.
 */
export async function verifyBridgeRequest(
  request: Request,
  opts: { requireWrite?: boolean } = {},
): Promise<VerifiedBridgeRequest | Response> {
  let secrets;
  try {
    secrets = getBridgeSecrets();
  } catch (err) {
    return jsonResponse(
      { error: (err as Error).message },
      { status: 500 },
    );
  }

  const rawBody =
    request.method === "GET" || request.method === "HEAD"
      ? ""
      : await request.text();
  const timestamp = request.headers.get("x-timestamp") ?? "";
  const actorHeader = request.headers.get("x-actor") ?? "";
  const signature = request.headers.get("x-signature") ?? "";

  if (!timestamp || !actorHeader || !signature) {
    return jsonResponse(
      { error: "missing_signed_headers" },
      { status: 400 },
    );
  }

  const result = verifySignature({
    currentSecret: secrets.current,
    previousSecret: secrets.previous,
    timestamp,
    actor: actorHeader,
    rawBody,
    signature,
  });
  if (!result.valid) {
    return jsonResponse({ error: result.reason }, { status: 401 });
  }

  const actor = parseActorHeader(actorHeader);
  if (!actor) {
    return jsonResponse({ error: "invalid_actor" }, { status: 400 });
  }

  if (opts.requireWrite && !actorMayWrite(actor)) {
    return jsonResponse(
      { error: "actor_role_not_permitted" },
      { status: 403 },
    );
  }

  return { actor, rawBody, secretUsed: result.secretUsed };
}

export function parseBridgeBody(rawBody: string):
  | { record: Record<string, unknown>; expectedUpdatedAt?: string }
  | { error: string } {
  if (!rawBody) return { error: "empty_body" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { error: "invalid_json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "body_must_be_object" };
  }
  const obj = parsed as Record<string, unknown>;
  // Two accepted shapes: { record: {...}, expected_updated_at? }
  // or a bare record (no wrapper). Detect by presence of `record`.
  if ("record" in obj && obj.record && typeof obj.record === "object") {
    const expected = obj.expected_updated_at;
    return {
      record: obj.record as Record<string, unknown>,
      expectedUpdatedAt: typeof expected === "string" ? expected : undefined,
    };
  }
  return { record: obj };
}

/**
 * Whitelist filter: drops keys not in `allowed`, coerces empty strings to null.
 * Rejects with an error listing unexpected keys when `strict` is true.
 */
export function pickAllowed(
  record: Record<string, unknown>,
  allowed: readonly string[],
  opts: { strict?: boolean } = {},
): { data: Record<string, unknown> } | { error: string; unexpected: string[] } {
  const unexpected: string[] = [];
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (!allowed.includes(k)) {
      unexpected.push(k);
      continue;
    }
    data[k] = v === "" ? null : v;
  }
  if (opts.strict && unexpected.length > 0) {
    return { error: "unexpected_fields", unexpected };
  }
  return { data };
}
