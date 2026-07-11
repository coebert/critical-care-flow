/**
 * HTTP security headers applied to every server response.
 *
 * Batch B / P2 hardening — see `.lovable/plan.md`. These are defence-in-depth
 * headers that complement the meta-tag equivalents already set in
 * `src/routes/__root.tsx`. HTTP headers take precedence over their meta
 * counterparts and cover non-HTML responses (JSON, redirects, error pages).
 *
 * Deliberately excluded for now:
 * - `Content-Security-Policy` — needs a product decision on directives (see
 *   plan, item 5). Adding it wrong breaks the app; we ship it separately
 *   once we have a report-only baseline.
 * - `Access-Control-Allow-Origin` — bridge webhook routes set their own CORS
 *   headers; we do not want a blanket allow-origin.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  // Force HTTPS for 2 years, cover subdomains, allow HSTS preload.
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  // Block MIME-type sniffing.
  "X-Content-Type-Options": "nosniff",
  // Disallow framing entirely — this app does not embed itself anywhere.
  "X-Frame-Options": "DENY",
  // Trim referrer leakage on cross-origin navigations.
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // No powerful browser features are used.
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()",
  // Isolate the browsing context group.
  "Cross-Origin-Opener-Policy": "same-origin",
  // Prevent other origins from embedding our subresources.
  "Cross-Origin-Resource-Policy": "same-origin",
};

/**
 * Return a new Response with the security headers merged in. Existing headers
 * on the response win (so route handlers that intentionally set e.g. their
 * own `Cross-Origin-Resource-Policy` for a public asset are respected).
 */
export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
