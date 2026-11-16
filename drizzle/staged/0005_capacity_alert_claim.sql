-- STAGED FOR REVIEW — NOT APPLIED. Apply in the coordinated release.
-- Forward-only, additive.
--
-- Capacity alerts: one atomic claim of a state transition + in-app
-- notifications, with stable event identities so concurrent triggers or
-- retries never duplicate, and a newer state is never blindly replayed.
-- External push delivery is recorded separately (never promised exactly-once).

ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS event_key text;
COMMENT ON COLUMN public.notifications.event_key IS
  'Stable alert event identity (capacity alerts). Unique per user so retries/concurrent triggers cannot duplicate.';
CREATE UNIQUE INDEX IF NOT EXISTS notifications_user_event_key_uniq
  ON public.notifications (user_id, event_key) WHERE event_key IS NOT NULL;

ALTER TABLE public.nurse_capacity_alert_state
  ADD COLUMN IF NOT EXISTS state_revision bigint NOT NULL DEFAULT 0;
COMMENT ON COLUMN public.nurse_capacity_alert_state.state_revision IS
  'Compare-and-set revision; only claim_nurse_capacity_transition() advances it.';

CREATE TABLE IF NOT EXISTS public.nurse_capacity_alert_events (
  event_key text PRIMARY KEY,
  shift_key text NOT NULL,
  levels text[] NOT NULL,
  from_revision bigint NOT NULL,
  to_revision bigint NOT NULL,
  recipients integer NOT NULL,
  notifications_inserted integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  push_attempted integer,
  push_delivered integer,
  push_failed integer,
  push_recorded_at timestamptz
);
GRANT ALL ON public.nurse_capacity_alert_events TO service_role;
ALTER TABLE public.nurse_capacity_alert_events ENABLE ROW LEVEL SECURITY;
-- No policies: written only by the service-role server path below.

CREATE OR REPLACE FUNCTION public.claim_nurse_capacity_transition(
  _expected_revision bigint,
  _state jsonb,
  _event_key text,
  _levels text[],
  _notifications jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _cur bigint;
  _next bigint;
  _inserted integer := 0;
  _recipients integer := 0;
BEGIN
  INSERT INTO public.nurse_capacity_alert_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
  SELECT state_revision INTO _cur FROM public.nurse_capacity_alert_state WHERE id = true FOR UPDATE;
  IF _cur IS DISTINCT FROM _expected_revision THEN
    -- Someone else already moved the state on: do not replay ours.
    RETURN jsonb_build_object('claimed', false, 'reason', 'state_changed');
  END IF;
  _next := _cur + 1;

  UPDATE public.nurse_capacity_alert_state SET
    shift_key = _state->>'shift_key',
    level3_available = (_state->>'level3_available')::boolean,
    level2_available = (_state->>'level2_available')::boolean,
    level1_available = (_state->>'level1_available')::boolean,
    level3_slots = (_state->>'level3_slots')::integer,
    level2_slots = (_state->>'level2_slots')::integer,
    level1_slots = (_state->>'level1_slots')::integer,
    spare = (_state->>'spare')::integer,
    level3_last_alerted_at = (_state->>'level3_last_alerted_at')::timestamptz,
    level2_last_alerted_at = (_state->>'level2_last_alerted_at')::timestamptz,
    level1_last_alerted_at = (_state->>'level1_last_alerted_at')::timestamptz,
    state_revision = _next,
    updated_at = now()
  WHERE id = true;

  IF _event_key IS NOT NULL THEN
    _recipients := COALESCE(jsonb_array_length(_notifications), 0);
    INSERT INTO public.notifications (user_id, referral_id, kind, message, event_key)
    SELECT (n->>'user_id')::uuid, NULL, 'capacity', n->>'message', _event_key
    FROM jsonb_array_elements(COALESCE(_notifications, '[]'::jsonb)) AS n
    ON CONFLICT (user_id, event_key) WHERE event_key IS NOT NULL DO NOTHING;
    GET DIAGNOSTICS _inserted = ROW_COUNT;
    -- Primary key on event_key: a duplicate event aborts the whole claim.
    INSERT INTO public.nurse_capacity_alert_events
      (event_key, shift_key, levels, from_revision, to_revision, recipients, notifications_inserted)
    VALUES (_event_key, _state->>'shift_key', _levels, _cur, _next, _recipients, _inserted);
  END IF;

  RETURN jsonb_build_object('claimed', true, 'revision', _next, 'notifications_inserted', _inserted);
END;
$$;
REVOKE ALL ON FUNCTION public.claim_nurse_capacity_transition(bigint, jsonb, text, text[], jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_nurse_capacity_transition(bigint, jsonb, text, text[], jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.record_capacity_alert_delivery(
  _event_key text,
  _attempted integer,
  _delivered integer,
  _failed integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.nurse_capacity_alert_events
     SET push_attempted = _attempted,
         push_delivered = _delivered,
         push_failed = _failed,
         push_recorded_at = now()
   WHERE event_key = _event_key AND push_recorded_at IS NULL;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.record_capacity_alert_delivery(text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_capacity_alert_delivery(text, integer, integer, integer) TO service_role;
