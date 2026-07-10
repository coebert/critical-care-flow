export const bridgeCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "content-type, x-timestamp, x-actor, x-signature, x-signature-previous, apikey",
  "Access-Control-Max-Age": "86400",
};

export function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...bridgeCorsHeaders,
      ...(init.headers ?? {}),
    },
  });
}

export function preflight() {
  return new Response(null, { status: 204, headers: bridgeCorsHeaders });
}
