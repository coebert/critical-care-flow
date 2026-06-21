
DROP FUNCTION IF EXISTS public.check_auth_lockout(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.record_auth_attempt(TEXT, TEXT, BOOLEAN);

CREATE OR REPLACE FUNCTION public.begin_auth_attempt(_email TEXT, _attempt_type TEXT)
RETURNS JSONB
LANGUAGE plpgsql
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
  _attempt_id BIGINT;
BEGIN
  IF _email_norm = '' OR _attempt_type NOT IN ('signin','reset') THEN
    RETURN jsonb_build_object('locked', false, 'attempt_id', NULL, 'remaining_attempts', _max_attempts);
  END IF;

  -- Serialize concurrent check+reserve for the same email+type within the current transaction.
  -- Released automatically at txn end (each RPC call is its own implicit transaction).
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

  -- Reserve the slot atomically by inserting a pending failure row.
  -- If the attempt later succeeds, finalize_auth_attempt clears it.
  INSERT INTO public.auth_throttle (email_norm, attempt_type, success)
  VALUES (_email_norm, _attempt_type, false)
  RETURNING id INTO _attempt_id;

  RETURN jsonb_build_object(
    'locked', false,
    'attempt_id', _attempt_id,
    'remaining_attempts', GREATEST(0, _max_attempts - _failure_count - 1)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_auth_attempt(_attempt_id BIGINT, _success BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _email_norm TEXT;
  _attempt_type TEXT;
BEGIN
  IF _attempt_id IS NULL THEN
    RETURN;
  END IF;

  SELECT email_norm, attempt_type
    INTO _email_norm, _attempt_type
    FROM public.auth_throttle
   WHERE id = _attempt_id;

  IF _email_norm IS NULL THEN
    RETURN;
  END IF;

  IF _success THEN
    -- Serialize against concurrent begin_auth_attempt for the same email+type.
    PERFORM pg_advisory_xact_lock(hashtextextended(_email_norm || '|' || _attempt_type, 0));
    -- Successful auth clears all pending failures for this email+type.
    DELETE FROM public.auth_throttle
     WHERE email_norm = _email_norm
       AND attempt_type = _attempt_type
       AND success = false;
    INSERT INTO public.auth_throttle (email_norm, attempt_type, success)
    VALUES (_email_norm, _attempt_type, true);
  END IF;
  -- On failure: reserved row stays as success=false and continues to count.

  DELETE FROM public.auth_throttle WHERE attempted_at < now() - INTERVAL '24 hours';
END;
$$;

REVOKE ALL ON FUNCTION public.begin_auth_attempt(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_auth_attempt(BIGINT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.begin_auth_attempt(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_auth_attempt(BIGINT, BOOLEAN) TO anon, authenticated;
