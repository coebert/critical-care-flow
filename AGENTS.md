<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Internal SECURITY DEFINER maintenance/throttle RPCs are executable by service_role only and called via supabaseAdmin inside server functions; browser flows use src/lib/auth-throttle.functions.ts, which derives principal and success server-side (guarded by src/lib/internal-rpc-callsites.test.ts).
- Every capacity surface and capacity alert derives from src/lib/unit-capacity.ts (validated ICU Handover Hub roster + CCC acuity + staffing) via src/hooks/use-unit-capacity.ts shared query keys and src/lib/shift-clock.ts (Europe/London); never from local bed_occupancies — why: one trustworthy number everywhere, unknown/stale never shown as room.
- Partner bed-board reads go through src/lib/partner-bed-board.server.ts, which checks has_clinical_access before building any signed request; bed-board URLs carry only opaque ids (src/lib/bed-board-search.ts) — why: no clinical data or identifiers leak to unauthorised callers or URLs.
- Wardable changes reach the Hub only via signed POST /patients/wardable with a durable per-patient desired_revision from set_wardable_desired_state; outcomes saved only while that revision is current; a review retry sends only its signed token (user, patient, local revision/value, Hub updated_at) with that CAS unchanged — why: a stale in-flight sync or stale review can never overwrite a newer intent.
- Acuity edits require the exact expected updated_at string (DB precision CAS, never Date.parse) — why: microsecond-different revisions must conflict.
- Capacity alerts fail closed on any stale/failed input and claim state + in-app notifications atomically through a service_role RPC — why: no alert from uncertain data, no duplicates.
- New SQL awaiting a coordinated release lives in drizzle/staged/ (not applied); app code must degrade safely until it is — why: paired Hub/CCC releases.
- The old two-way bridge mirror is retired: bridge/sync, retry-failed, reconcile worker and every inbound bridge POST that upserted rows (src/lib/bridge-inbound-retired.server.ts: signed callers get 410, zero DB calls) — Hub owns patients/beds/placement, CCC owns referrals/investigations/microbiology and the Hub only GETs `?sync=1` — why: one source of truth per entity, no non-atomic overwrite of native edits.
- Clinical UI is keyed by user + clinical epoch (src/lib/session-scope.ts); authoritative denials reach the shared gate via the global query/mutation caches, and async replies pass src/lib/request-guard.ts — why: no patient data or late reply survives a denial, sign-out or selection change.
- "Keep me signed in" is enforced around the generated auth storage by src/lib/session-retention.ts (installed in getRouter before first auth read; tab-only sessions wiped on next start-up after the last tab closes/crashes); never move the token out of the auth client's storage — why: auth-js re-reads storage on every getSession/refresh.
- Post-sign-in targets pass src/lib/safe-redirect.ts in validateSearch (key always returned — the router merges raw search) and again before navigate — why: no external or normalised-to-external navigation.
- Client-only (`ssr:false`) guards that redirect to an SSR page await src/lib/hydration-gate.ts (boundary marker = _authenticated pendingComponent) — why: redirecting mid-hydration is React #418.
- Optimistic writes, rollbacks and toasts in useMutation options check captureEpochs/epochsCurrent (request-guard.ts) — why: mutation callbacks outlive unmount and must not refill a purged cache.
- Referrals are never hard-deleted by clients: soft delete/restore only (deleted_at tombstone feeds the Hub), and delete/restore/note-delete server functions audit only when RETURNING confirms a row changed — why: tombstones must reach the Hub and the audit must never record a no-op.
