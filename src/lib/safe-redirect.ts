/**
 * Post-sign-in redirect targets must stay inside this app.
 *
 * Browsers normalise a lot before navigating: backslashes become slashes,
 * tabs/newlines are stripped, so `/\evil.example`, `/\t/evil.example` or
 * `/%5Cevil.example` style inputs can turn into protocol-relative URLs. Only
 * plain same-origin absolute paths survive; anything else falls back to "/".
 */
const BASE = "https://internal.invalid";
const MAX_LEN = 2048;

export function safeInternalRedirect(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_LEN) return null;
  // Control characters (incl. tab/CR/LF stripped by the URL parser), DEL,
  // backslashes and whitespace never appear in a legitimate app path.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f\\]/.test(raw)) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  // Encoded separators that decode into a scheme-relative or backslash path.
  let decoded = raw;
  for (let i = 0; i < 3; i++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return null;
    }
    if (next === decoded) break;
    decoded = next;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(decoded) || decoded.startsWith("//")) return null;
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  const path = `${url.pathname}${url.search}${url.hash}`;
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  // Never bounce back into the sign-in page itself.
  if (url.pathname === "/auth" || url.pathname.startsWith("/auth/")) return null;
  return path;
}
