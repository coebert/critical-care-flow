
-- Auth throttle / brute-force protection
CREATE TABLE public.auth_throttle (
  id BIGSERIAL PRIMARY KEY,
  email_norm TEXT NOT NULL,
  attempt_type TEXT NOT NULL CHECK (attempt_type IN ('signin','reset')),
  success BOOLEAN NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX auth_throttle_lookup_idx
  ON public.auth_throttle (email_norm, attempt_type, attempted_at DESC);

GRANT ALL ON public.auth_throttle TO service_role;
-- No grants to anon/authenticated: the table is only touched via SECURITY DEFINER functions below.

ALTER TABLE public.auth_throttle ENABLE ROW LEVEL SECURITY;
-- No policies: blocks any direct access from anon/authenticated even if grants are ever added.

-- Check whether an email is currently locked out for a given attempt type.
CREATE OR REPLACE FUNCTION public.check_auth_lockout(_email TEXT, _attempt_type TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _email_norm TEXT := lower(trim(_email));
  _window_start TIMESTAMPTZ := now() - INTERVAL '15 minutes';
  _max_attempts INT := 5;
  _failure_count INT;
  _oldest_failure TIMESTAMPTZ;
  _unlocks_at TIMESTAMPTZ;
BEGIN
  IF _email_norm = '' OR _attempt_type NOT IN ('signin','reset') THEN
    RETURN jsonb_build_object('locked', false, 'remaining_attempts', _max_attempts);
  END IF;

  SELECT count(*), min(attempted_at)
    INTO _failure_count, _oldest_failure
    FROM public.auth_throttle
   WHERE email_norm = _email_norm
     AND attempt_type = _attempt_type
     AND success = false
     AND attempted_at >= _window_start;

  IF _failure_count >= _max_attempts THEN
    _unlocks_at := _oldest_failure + INTERVAL '15 minutes';
    RETURN jsonb_build_object(
      'locked', true,
      'unlocks_at', _unlocks_at,
      'retry_after_seconds', GREATEST(0, EXTRACT(EPOCH FROM (_unlocks_at - now()))::INT)
    );
  END IF;

  RETURN jsonb_build_object(
    'locked', false,
    'remaining_attempts', _max_attempts - _failure_count
  );
END;
$$;

-- Record a sign-in / reset attempt. Successful attempts clear prior failures for the same email+type.
CREATE OR REPLACE FUNCTION public.record_auth_attempt(_email TEXT, _attempt_type TEXT, _success BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _email_norm TEXT := lower(trim(_email));
BEGIN
  IF _email_norm = '' OR _attempt_type NOT IN ('signin','reset') THEN
    RETURN;
  END IF;

  INSERT INTO public.auth_throttle (email_norm, attempt_type, success)
  VALUES (_email_norm, _attempt_type, _success);

  IF _success THEN
    DELETE FROM public.auth_throttle
     WHERE email_norm = _email_norm
       AND attempt_type = _attempt_type
       AND success = false;
  END IF;

  -- Opportunistic cleanup of old rows (older than 24h) to keep the table small.
  DELETE FROM public.auth_throttle
   WHERE attempted_at < now() - INTERVAL '24 hours';
END;
$$;

REVOKE ALL ON FUNCTION public.check_auth_lockout(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_auth_attempt(TEXT, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_auth_lockout(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_auth_attempt(TEXT, TEXT, BOOLEAN) TO anon, authenticated;
