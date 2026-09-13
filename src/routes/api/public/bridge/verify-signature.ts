import { createFileRoute } from "@tanstack/react-router";
import { jsonResponse, preflight } from "@/lib/bridge-cors";
import {
  getBridgeSecrets,
  signWith,
  verifySignature,
} from "@/lib/bridge-hmac.server";
import { isBridgeCallerAuthorized } from "@/lib/bridge-caller-auth.server";

/**
 * Bridge signature diagnostic endpoint.
 *
 *  - GET returns a canonical signed payload produced by THIS server's current
 *    HANDOVER_API_SECRET. The peer can reproduce the signature locally to
 *    confirm both sides hold the identical secret.
 *  - POST verifies the caller's supplied signature over `payload` and
 *    returns `{ valid: true, secret_used: "current"|"previous" }` on success.
 *
 * GET is a signing oracle (it emits a signature produced with the live
 * secret), so it requires the internal caller credential. POST is
 * self-authenticating — it only succeeds for a caller that already holds a
 * valid signature.
 */
export const Route = createFileRoute("/api/public/bridge/verify-signature")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => preflight(request),

      GET: async ({ request }) => {
        // Never hand out a live signature to an anonymous caller.
        if (!(await isBridgeCallerAuthorized(request))) {
          return jsonResponse({ error: "unauthorized" }, { status: 401 });
        }
        let secrets;
        try {
          secrets = getBridgeSecrets();
        } catch (err) {
          return jsonResponse(
            { error: (err as Error).message },
            { status: 500 },
          );
        }
        const timestamp = String(Math.floor(Date.now() / 1000));
        const actor = JSON.stringify({
          id: "bridge-selftest",
          role: "system",
        });
        const rawBody = JSON.stringify({ probe: "verify-signature", timestamp });
        const signature = signWith(secrets.current, {
          timestamp,
          actor,
          rawBody,
        });
        return jsonResponse({
          ok: true,
          scheme: "HMAC-SHA256 over `${ts}.${actor}.${rawBody}`",
          headers: {
            "x-timestamp": timestamp,
            "x-actor": actor,
            "x-signature": signature,
          },
          raw_body: rawBody,
          max_skew_seconds: 300,
        });
      },

      POST: async ({ request }) => {
        let secrets;
        try {
          secrets = getBridgeSecrets();
        } catch (err) {
          return jsonResponse(
            { error: (err as Error).message },
            { status: 500 },
          );
        }

        const rawBody = await request.text();
        const timestamp = request.headers.get("x-timestamp") ?? "";
        const actor = request.headers.get("x-actor") ?? "";
        const signature = request.headers.get("x-signature") ?? "";

        if (!timestamp || !actor || !signature) {
          return jsonResponse(
            { valid: false, reason: "missing_signed_headers" },
            { status: 400 },
          );
        }

        const result = verifySignature({
          currentSecret: secrets.current,
          previousSecret: secrets.previous,
          timestamp,
          actor,
          rawBody,
          signature,
        });

        if (!result.valid) {
          return jsonResponse(
            { valid: false, reason: result.reason },
            { status: 401 },
          );
        }
        return jsonResponse({
          valid: true,
          secret_used: result.secretUsed,
          echo_bytes: rawBody.length,
        });
      },
    },
  },
});
