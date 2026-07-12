/**
 * Shared helpers for classifying partner-bridge failures.
 *
 * When the partner (icu-compass-care) is fully down, Lovable's platform
 * returns a generic HTML "This page didn't load" shell with a 5xx status
 * instead of the partner's JSON error envelope. We detect that specific
 * shape so:
 *   1. Our UI can show "Partner Handover Hub is currently unavailable"
 *      instead of a raw HTML dump.
 *   2. `bridge_sync_attempts.error` stores a compact classification instead
 *      of 200 chars of noisy HTML repeated across every resource.
 *   3. `bridge-status` admins can see partner reachability at a glance
 *      without eyeballing every row.
 */

export type PartnerFailureClass =
  | "outage" // partner unreachable / HTML shell / 5xx
  | "rate_limited" // 429
  | "client_error" // non-transient 4xx
  | "network" // fetch threw
  | "invalid_json" // OK status but body not JSON
  | "unknown";

export type PartnerFailure = {
  class: PartnerFailureClass;
  message: string;
  status: number; // 0 for network errors
  is_outage: boolean;
};

const HTML_MARKERS = [
  "<!doctype",
  "<html",
  "this page didn't load",
  "this page didn&#39;t load",
];

function looksLikeHtmlShell(body: string): boolean {
  if (!body) return false;
  const head = body.slice(0, 512).toLowerCase();
  return HTML_MARKERS.some((m) => head.includes(m));
}

/**
 * Classify an HTTP response body received from the partner.
 * `body` is the raw text we already read (may be empty). Caller decides how
 * much of the body to pass in — this only sniffs the first 512 chars.
 */
export function classifyPartnerHttpFailure(
  status: number,
  body: string,
): PartnerFailure {
  const html = looksLikeHtmlShell(body);
  if (status >= 500 && status < 600) {
    return {
      class: "outage",
      message: html
        ? `Partner Handover Hub is currently unavailable (HTTP ${status}, platform error page).`
        : `Partner returned HTTP ${status}: ${body.slice(0, 160) || "no body"}`,
      status,
      is_outage: true,
    };
  }
  if (status === 429) {
    return {
      class: "rate_limited",
      message: `Partner rate-limited us (HTTP 429).`,
      status,
      is_outage: false,
    };
  }
  if (status === 408) {
    return {
      class: "outage",
      message: `Partner request timed out (HTTP 408).`,
      status,
      is_outage: true,
    };
  }
  if (status >= 400) {
    return {
      class: "client_error",
      message: `Partner rejected the request (HTTP ${status}): ${
        body.slice(0, 160) || "no body"
      }`,
      status,
      is_outage: false,
    };
  }
  return {
    class: "unknown",
    message: `Partner returned unexpected status ${status}`,
    status,
    is_outage: false,
  };
}

/** Classify a thrown fetch error (network unreachable, DNS, TLS, …). */
export function classifyPartnerNetworkFailure(err: unknown): PartnerFailure {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    class: "network",
    message: `Partner unreachable: ${msg.slice(0, 200)}`,
    status: 0,
    is_outage: true,
  };
}

/** True when a message string almost certainly represents a partner outage. */
export function isOutageMessage(msg: string | null | undefined): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return (
    m.includes("partner handover hub is currently unavailable") ||
    m.includes("partner unreachable") ||
    m.includes("partner request timed out")
  );
}
