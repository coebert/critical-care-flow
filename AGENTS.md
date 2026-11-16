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
- Wardable changes reach the Hub only via signed POST /patients/wardable with a durable per-patient desired_revision from set_wardable_desired_state; outcomes saved only while that revision is current — why: a stale in-flight sync can never overwrite a newer intent.
- Acuity edits require the exact expected updated_at string (DB precision CAS, never Date.parse) — why: microsecond-different revisions must conflict.
- Capacity alerts fail closed on any stale/failed input and claim state + in-app notifications atomically through a service_role RPC — why: no alert from uncertain data, no duplicates.
- New SQL awaiting a coordinated release lives in drizzle/staged/ (not applied); app code must degrade safely until it is — why: paired Hub/CCC releases.
- The old two-way bridge mirror (bridge/sync, retry-failed, reconcile worker) is retired: auth-checked, no mutations; Hub owns patients/placement and pulls CCC referrals — why: one source of truth per entity.
