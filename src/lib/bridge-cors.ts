/**
 * CORS headers for the partner bridge routes under /api/public/bridge/*.
 *
 * Batch B / P2 hardening: previously these routes returned
 * `Access-Control-Allow-Origin: *` unconditionally. The bridge is a
 * server-to-server API (HMAC-signed, timestamp-anchored) so CORS is not the
 * primary defence, but a wildcard invites any browser origin to attempt
 * cross-origin requests using the caller's credentials-free context. That is
 * exactly the surface CORS is meant to constrain.
 *
 * New behaviour:
 *   - Parse an allow-list from the `BRIDGE_ALLOWED_ORIGINS` env var
 *     (comma-separated, e.g. "https://bridge.partner.nhs.uk,https://ops.example").
 *   - If the request `Origin` header matches an allowed entry, reflect it
 *     (with `Vary: Origin`) so browsers accept the response.
 *   - Otherwise omit `Access-Control-Allow-Origin` entirely — browsers will
 *     block the response, while server-to-server callers (which don't check
 *     CORS) are unaffected.
 *   - When the env var is unset or empty, fall back to `*` to preserve
 *     existing deployments until operators explicitly tighten it. Log a
 *     one-time warning so this is visible in server logs.
 */

const ALLOWED_METHODS = "GET, POST, OPTIONS";
const ALLOWED_HEADERS =
  "content-type, x-timestamp, x-actor, x-signature, x-signature-previous, apikey";
const MAX_AGE = "86400";

let warnedFallback = false;

function parseAllowList(): string[] {
  const raw = process.env.BRIDGE_ALLOWED_ORIGINS ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function baseHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Max-Age": MAX_AGE,
  };
}

export function buildBridgeCorsHeaders(
  origin: string | null,
): Record<string, string> {
  const headers = baseHeaders();
  const allowList = parseAllowList();

  if (allowList.length === 0) {
    if (!warnedFallback) {
      warnedFallback = true;
      console.warn(
        "[bridge-cors] BRIDGE_ALLOWED_ORIGINS is not set; falling back to '*'. " +
          "Set a comma-separated allow-list of partner origins for defence in depth.",
      );
    }
    headers["Access-Control-Allow-Origin"] = "*";
    return headers;
  }

  if (origin && allowList.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  // Otherwise: omit Access-Control-Allow-Origin. Browsers will reject the
  // response; server-to-server callers ignore CORS and continue working.
  return headers;
}

/**
 * Back-compat export for call sites that only want the static header set
 * (never used by the routes themselves — kept so external tests importing it
 * do not break). Prefer `buildBridgeCorsHeaders(origin)`.
 */
export const bridgeCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": ALLOWED_METHODS,
  "Access-Control-Allow-Headers": ALLOWED_HEADERS,
  "Access-Control-Max-Age": MAX_AGE,
} as const;

export function jsonResponse(
  body: unknown,
  init: ResponseInit & { request?: Request } = {},
) {
  const { request, ...rest } = init;
  const origin = request?.headers.get("origin") ?? null;
  return new Response(JSON.stringify(body), {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...buildBridgeCorsHeaders(origin),
      ...(rest.headers ?? {}),
    },
  });
}

export function preflight(request?: Request) {
  const origin = request?.headers.get("origin") ?? null;
  return new Response(null, {
    status: 204,
    headers: buildBridgeCorsHeaders(origin),
  });
}
