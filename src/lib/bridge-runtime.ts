/**
 * Classify which Critical Care Connect runtime answered a bridge request,
 * from the request host alone (no secrets). Lets the Hub's operators tell
 * from /api/public/bridge/health whether PARTNER_BRIDGE_URL points at the
 * published app or a preview build.
 *
 *  - published: the custom/published *.lovable.app name or the stable
 *    `project--<uuid>.lovable.app` production URL
 *  - preview:   the stable `project--<uuid>-dev.lovable.app` preview URL or an
 *    `id-preview--` editor preview (the latter sits behind the Lovable login
 *    wall, so a server-to-server caller never reaches it: it answers 401)
 *  - local:     localhost / 127.0.0.1 (dev server, tests)
 */
export type BridgeRuntime = "published" | "preview" | "local" | "unknown";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const STABLE_PREVIEW = new RegExp(`^project--${UUID}-dev\\.lovable\\.app$`);
const STABLE_PUBLISHED = new RegExp(`^project--${UUID}\\.lovable\\.app$`);

export function classifyBridgeHost(rawHost: string): BridgeRuntime {
  const host = rawHost.toLowerCase().replace(/:\d+$/, "");
  if (host === "localhost" || host === "127.0.0.1") return "local";
  if (STABLE_PREVIEW.test(host) || host.startsWith("id-preview--") || host.startsWith("preview--")) return "preview";
  if (STABLE_PUBLISHED.test(host)) return "published";
  if (/^[a-z0-9-]+\.lovable\.app$/.test(host)) return "published";
  return "unknown";
}
