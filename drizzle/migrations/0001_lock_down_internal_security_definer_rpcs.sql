-- Internal maintenance / throttling routines: service_role only.
REVOKE ALL ON FUNCTION public.expire_stale_notifications(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_auth_attempt(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_auth_attempt(bigint, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_privileged_action(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_privileged_action(bigint, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_bridge_cron_state() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.expire_stale_notifications(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_auth_attempt(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_auth_attempt(bigint, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_privileged_action(uuid, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_privileged_action(bigint, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_bridge_cron_state() TO service_role;

-- Push subscription claim: signed-in users only (function keeps its auth.uid() owner check).
REVOKE ALL ON FUNCTION public.claim_push_subscription(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_push_subscription(text, text, text, text) TO authenticated, service_role;