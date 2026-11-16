# Hub scheduled inbound pull failing (`partner_http_error`) — CCC-side diagnosis and staged fix

Status: STAGED. No secret, cron job or publication has been changed. Apply only at a
release approved for both apps.

## What was checked (read-only, metadata only)

| Check | Result |
| --- | --- |
| `GET /api/public/bridge/health` on `critical-care-flow.lovable.app`, `project--a8eeeba1-…lovable.app`, `project--a8eeeba1-…-dev.lovable.app` | 200, `secret_configured: true`, `previous_secret_configured: false` |
| Unsigned `GET /api/public/bridge/referrals?sync=1&limit=1` on those three hosts | 400 `missing_signed_headers` — the feed route is live and checks signatures |
| Same two paths on `id-preview--a8eeeba1-…lovable.app` | 401 `text/plain` from the Lovable login wall; never reaches CCC code and never appears in CCC logs |
| CCC request logs, all deployments (published + preview hosts), 19:02–20:02 UTC | No `GET …/bridge/{referrals,investigations,microbiology}` at all except one batch at 19:54:05–19:54:30 (a `limit=1` probe, then `limit=500` ×3, all 200). CCC's own 2-minute cron calls are all present, so logging was not dropping requests. |
| Hub source (snapshot `34a91081`, `src/lib/bridge-client.server.ts`) | Pull = signed `GET ${PARTNER_BRIDGE_URL}/api/public/bridge/<resource>?sync=1&limit=500`. `partner_http_error` is raised only for a non-2xx HTTP reply; a network failure is `partner_unreachable`. |
| Contract | Compatible: `schema_version` 1 both sides; Hub page size 500 = CCC maximum 500; same HMAC message `${ts}.${actor}.${rawBody}`; Hub actor role `admin` is accepted (GET needs no write role). |
| Schedulers | Hub job `bridge-sync-every-5-min` calls the Hub's own production URL (`project--58df96bd-…`), so the Hub's PUBLISHED build does the pull. CCC jobs 6/7/8 call `critical-care-flow.lovable.app` (published CCC) and hit retired no-op endpoints. |

## Proven

The 19:30 UTC failure was a non-2xx HTTP reply that did **not** come from any CCC
deployment: no CCC deployment received the Hub's scheduled requests. A wrong shared
secret, a missing route, a contract mismatch or a CCC error would each have been
answered (and logged) by CCC, so none of them is the cause.

## Inference (not provable from CCC)

The Hub's published runtime is sending its pulls to a host other than the CCC
published app. The CCC editor preview (`id-preview--a8eeeba1-…`) matches the evidence
exactly (401 at the login wall for every server-to-server call). I cannot read the
Hub's `PARTNER_BRIDGE_URL` value or the Hub's logs, so the exact host is unconfirmed.
Something on the Hub side probably changed between 18:25 and 18:30 UTC (its secret, or
a Hub publish).

Two Hub-side read-only checks settle it:
1. Hub bridge health reports `config.partnerHost` (host only, no secret).
2. The Hub's server log line `[bridge-client] partner GET failed <path> <status>`:
   401 means the preview login wall, 404 means a wrong host or path.

## Staged fix (at release)

1. In ICU Handover Hub, set `PARTNER_BRIDGE_URL` to the CCC published origin with no
   path and no trailing slash: `https://critical-care-flow.lovable.app` (or the
   rename-proof `https://project--a8eeeba1-1944-4344-93c0-4f9de4184412.lovable.app`).
   Never use an `id-preview--` URL. A `-dev` URL would pull from unreleased preview code.
2. Leave `HANDOVER_API_SECRET` unchanged: the evidence does not point to the secret.
3. Publish CCC. Then `GET /api/public/bridge/health` also returns `runtime`
   (`published` / `preview`) and `contract` (schema version, page limit, sync paths,
   `inbound_writes: "retired"`), so a misdirected URL shows up immediately.
4. Verify after the next 5-minute Hub run: CCC logs show 3 × `GET …?sync=1&limit=500 → 200`,
   and the Hub sync status shows ok for referrals, investigations and microbiology.

Optional clean-up, also needs approval: CCC jobs 6/7/8 (`bridge-sync`, `retry-failed`,
`bridge-reconcile-worker`) call retired endpoints that do nothing and can be
unscheduled.
