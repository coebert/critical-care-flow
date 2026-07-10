
CREATE OR REPLACE FUNCTION public.get_bridge_cron_state()
RETURNS TABLE(jobname text, schedule text, active boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, cron
AS $$
  SELECT j.jobname::text, j.schedule::text, j.active
    FROM cron.job j
   WHERE j.jobname = 'bridge-sync-every-2-min'
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_bridge_cron_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_bridge_cron_state() TO service_role;
