
-- 1. Mint a private random secret in Vault (only if not already present).
DO $$
DECLARE _exists boolean;
BEGIN
  SELECT EXISTS(SELECT 1 FROM vault.secrets WHERE name = 'bridge_cron_secret') INTO _exists;
  IF NOT _exists THEN
    PERFORM vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'bridge_cron_secret',
      'Shared secret authenticating pg_cron -> bridge sync/retry/reconcile endpoints');
  END IF;
END $$;

-- 2. SECURITY DEFINER accessor callable only by service_role (used by the
--    edge worker via supabaseAdmin to compare against the header).
CREATE OR REPLACE FUNCTION public.get_bridge_cron_secret()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public','vault'
AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'bridge_cron_secret' LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_bridge_cron_secret() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_bridge_cron_secret() TO service_role;

-- 3. Reschedule the three cron jobs so they send the private secret in an
--    x-cron-secret header instead of relying on the public anon apikey.
DO $$
DECLARE _cron_secret text;
BEGIN
  SELECT decrypted_secret INTO _cron_secret
    FROM vault.decrypted_secrets WHERE name = 'bridge_cron_secret' LIMIT 1;

  PERFORM cron.unschedule('bridge-sync-every-2-min');
  PERFORM cron.schedule(
    'bridge-sync-every-2-min',
    '*/2 * * * *',
    format($fmt$
      SELECT net.http_post(
        url := 'https://critical-care-flow.lovable.app/api/public/bridge/sync',
        headers := %L::jsonb,
        body := '{}'::jsonb
      );
    $fmt$, jsonb_build_object(
      'Content-Type','application/json',
      'x-cron-secret', _cron_secret
    )::text)
  );

  PERFORM cron.unschedule('bridge-retry-failed-every-5-min');
  PERFORM cron.schedule(
    'bridge-retry-failed-every-5-min',
    '*/5 * * * *',
    format($fmt$
      SELECT net.http_post(
        url := 'https://critical-care-flow.lovable.app/api/public/bridge/retry-failed',
        headers := %L::jsonb,
        body := '{}'::jsonb
      );
    $fmt$, jsonb_build_object(
      'Content-Type','application/json',
      'x-cron-secret', _cron_secret
    )::text)
  );

  PERFORM cron.unschedule('bridge-reconcile-worker-every-1-min');
  PERFORM cron.schedule(
    'bridge-reconcile-worker-every-1-min',
    '* * * * *',
    format($fmt$
      SELECT net.http_post(
        url := 'https://critical-care-flow.lovable.app/api/public/hooks/bridge-reconcile-worker',
        headers := %L::jsonb,
        body := '{}'::jsonb
      );
    $fmt$, jsonb_build_object(
      'Content-Type','application/json',
      'x-cron-secret', _cron_secret
    )::text)
  );
END $$;

-- 4. Replace the reconcile-jobs INSERT trigger so the "kick" http call
--    also uses the private secret rather than the public anon key.
CREATE OR REPLACE FUNCTION public.bridge_reconcile_jobs_kick_worker()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public','vault'
AS $function$
DECLARE _secret text;
BEGIN
  SELECT decrypted_secret INTO _secret
    FROM vault.decrypted_secrets WHERE name = 'bridge_cron_secret' LIMIT 1;

  PERFORM net.http_post(
    url := 'https://critical-care-flow.lovable.app/api/public/hooks/bridge-reconcile-worker',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-cron-secret', _secret
    ),
    body := jsonb_build_object('kick', NEW.id)
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block a job insert on the kick; pg_cron backstop will pick it up.
  RETURN NEW;
END;
$function$;
