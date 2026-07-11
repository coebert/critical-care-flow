-- Persist deep-link expiry on notification rows so:
--   * The runtime verifier in logReferralView can reject expired ids with
--     a single indexed column check instead of computing (now - created_at)
--     against every row.
--   * The admin lifecycle audit and reporting queries can filter/group
--     expired rows without ad-hoc date arithmetic.
-- Semantics: expired_at is set exactly once, by the scheduled cleanup
-- job (or a manual admin call), when a notification is still unread past
-- the 7-day TTL. It is NEVER set for a notification that was consumed
-- (read_at IS NOT NULL) — those follow the read lifecycle instead.

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS expired_at timestamptz;

-- Loosen the immutable-fields trigger so the cleanup job (running as
-- service_role) can populate expired_at. Every other column stays
-- immutable post-insert.
CREATE OR REPLACE FUNCTION public.notifications_protect_immutable_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.referral_id IS DISTINCT FROM OLD.referral_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.message IS DISTINCT FROM OLD.message
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Only read_at and expired_at may be modified on a notification'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

-- Partial index that keeps the cleanup sweep (and the runtime verifier's
-- "still-live?" lookup) proportional to the unread + unexpired working
-- set, not the whole table.
CREATE INDEX IF NOT EXISTS notifications_unused_created_at_idx
  ON public.notifications (created_at)
  WHERE read_at IS NULL AND expired_at IS NULL;

-- Cleanup routine. Idempotent: running it again after all stale rows
-- have been stamped is a no-op. Bounded by LIMIT to keep any single
-- sweep cheap; pg_cron re-runs on the next tick if there's more.
CREATE OR REPLACE FUNCTION public.expire_stale_notifications(_batch_limit integer DEFAULT 5000)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  updated integer;
BEGIN
  WITH candidates AS (
    SELECT id
      FROM public.notifications
     WHERE read_at IS NULL
       AND expired_at IS NULL
       AND created_at < now() - INTERVAL '7 days'
     ORDER BY created_at
     LIMIT GREATEST(1, LEAST(_batch_limit, 50000))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.notifications n
     SET expired_at = now()
    FROM candidates c
   WHERE n.id = c.id;
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated;
END;
$function$;

REVOKE ALL ON FUNCTION public.expire_stale_notifications(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expire_stale_notifications(integer) TO service_role;
