
CREATE OR REPLACE FUNCTION public.begin_auth_attempt(_email text, _attempt_type text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _email_norm TEXT := lower(trim(_email));
  _window_start TIMESTAMPTZ := now() - INTERVAL '15 minutes';
  _max_attempts INT := 5;
  _failure_count INT;
  _oldest_failure TIMESTAMPTZ;
  _unlocks_at TIMESTAMPTZ;
  _attempt_id BIGINT;
BEGIN
  -- 'setup' throttles the first-admin bootstrap endpoint. Same 5/15min rule.
  IF _email_norm = '' OR _attempt_type NOT IN ('signin','reset','setup') THEN
    RETURN jsonb_build_object('locked', false, 'attempt_id', NULL, 'remaining_attempts', _max_attempts);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_email_norm || '|' || _attempt_type, 0));

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
      'attempt_id', NULL,
      'unlocks_at', _unlocks_at,
      'retry_after_seconds', GREATEST(0, EXTRACT(EPOCH FROM (_unlocks_at - now()))::INT)
    );
  END IF;

  INSERT INTO public.auth_throttle (email_norm, attempt_type, success)
  VALUES (_email_norm, _attempt_type, false)
  RETURNING id INTO _attempt_id;

  RETURN jsonb_build_object(
    'locked', false,
    'attempt_id', _attempt_id,
    'remaining_attempts', GREATEST(0, _max_attempts - _failure_count - 1)
  );
END;
$function$;
