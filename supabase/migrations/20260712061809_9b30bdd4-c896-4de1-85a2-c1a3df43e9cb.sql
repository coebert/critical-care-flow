
CREATE TABLE public.privileged_action_throttle (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  action TEXT NOT NULL,
  success BOOLEAN NOT NULL DEFAULT false,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX privileged_action_throttle_lookup_idx
  ON public.privileged_action_throttle (user_id, action, attempted_at DESC);

GRANT ALL ON public.privileged_action_throttle TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.privileged_action_throttle_id_seq TO service_role;

ALTER TABLE public.privileged_action_throttle ENABLE ROW LEVEL SECURITY;

-- No policies for anon/authenticated: all access is via SECURITY DEFINER RPCs.

-- Atomic reservation: checks per-(user, action) failure count inside a
-- window and either grants the caller an attempt_id (locked=false) or
-- reports retry_after_seconds (locked=true). Uses a per-key advisory
-- lock so parallel calls are race-free, mirroring begin_auth_attempt.
CREATE OR REPLACE FUNCTION public.begin_privileged_action(
  _user_id UUID,
  _action TEXT,
  _max_attempts INT DEFAULT 5,
  _window_seconds INT DEFAULT 900
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _window_start TIMESTAMPTZ := now() - make_interval(secs => GREATEST(1, _window_seconds));
  _failure_count INT;
  _oldest_failure TIMESTAMPTZ;
  _unlocks_at TIMESTAMPTZ;
  _attempt_id BIGINT;
  _action_norm TEXT := lower(trim(_action));
BEGIN
  IF _user_id IS NULL OR _action_norm = '' THEN
    RETURN jsonb_build_object('locked', false, 'attempt_id', NULL, 'remaining_attempts', _max_attempts);
  END IF;

  IF _max_attempts < 1 OR _max_attempts > 1000 THEN
    RAISE EXCEPTION 'invalid _max_attempts' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_user_id::text || '|' || _action_norm, 0));

  SELECT count(*), min(attempted_at)
    INTO _failure_count, _oldest_failure
    FROM public.privileged_action_throttle
   WHERE user_id = _user_id
     AND action = _action_norm
     AND success = false
     AND attempted_at >= _window_start;

  IF _failure_count >= _max_attempts THEN
    _unlocks_at := _oldest_failure + make_interval(secs => _window_seconds);
    RETURN jsonb_build_object(
      'locked', true,
      'attempt_id', NULL,
      'unlocks_at', _unlocks_at,
      'retry_after_seconds', GREATEST(0, EXTRACT(EPOCH FROM (_unlocks_at - now()))::INT)
    );
  END IF;

  INSERT INTO public.privileged_action_throttle (user_id, action, success)
  VALUES (_user_id, _action_norm, false)
  RETURNING id INTO _attempt_id;

  RETURN jsonb_build_object(
    'locked', false,
    'attempt_id', _attempt_id,
    'remaining_attempts', GREATEST(0, _max_attempts - _failure_count - 1)
  );
END;
$$;

-- On success: clear pending failures for this (user, action) so the
-- caller isn't penalised for a legitimate completion. On failure: the
-- reserved row stays as success=false and continues to count against
-- the window. Also opportunistically prunes rows older than 24h.
CREATE OR REPLACE FUNCTION public.finalize_privileged_action(
  _attempt_id BIGINT,
  _success BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id UUID;
  _action TEXT;
BEGIN
  IF _attempt_id IS NULL THEN
    RETURN;
  END IF;

  SELECT user_id, action
    INTO _user_id, _action
    FROM public.privileged_action_throttle
   WHERE id = _attempt_id;

  IF _user_id IS NULL THEN
    RETURN;
  END IF;

  IF _success THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(_user_id::text || '|' || _action, 0));
    DELETE FROM public.privileged_action_throttle
     WHERE user_id = _user_id
       AND action = _action
       AND success = false;
    INSERT INTO public.privileged_action_throttle (user_id, action, success)
    VALUES (_user_id, _action, true);
  END IF;

  DELETE FROM public.privileged_action_throttle
   WHERE attempted_at < now() - INTERVAL '24 hours';
END;
$$;

REVOKE ALL ON FUNCTION public.begin_privileged_action(UUID, TEXT, INT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_privileged_action(BIGINT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.begin_privileged_action(UUID, TEXT, INT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_privileged_action(BIGINT, BOOLEAN) TO service_role;
