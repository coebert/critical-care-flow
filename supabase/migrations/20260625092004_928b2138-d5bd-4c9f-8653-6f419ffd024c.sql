CREATE OR REPLACE FUNCTION public.claim_push_subscription(
  p_endpoint TEXT,
  p_p256dh TEXT,
  p_auth TEXT,
  p_user_agent TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  IF p_endpoint IS NULL OR length(trim(p_endpoint)) = 0 OR length(p_endpoint) > 2000 THEN
    RAISE EXCEPTION 'Invalid push endpoint' USING ERRCODE = '22023';
  END IF;

  IF p_p256dh IS NULL OR length(trim(p_p256dh)) = 0 OR length(p_p256dh) > 500 THEN
    RAISE EXCEPTION 'Invalid push subscription key' USING ERRCODE = '22023';
  END IF;

  IF p_auth IS NULL OR length(trim(p_auth)) = 0 OR length(p_auth) > 500 THEN
    RAISE EXCEPTION 'Invalid push subscription auth secret' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.push_subscriptions (
    user_id,
    endpoint,
    p256dh,
    auth,
    user_agent,
    last_used_at
  )
  VALUES (
    v_user_id,
    p_endpoint,
    p_p256dh,
    p_auth,
    left(p_user_agent, 500),
    now()
  )
  ON CONFLICT (endpoint) DO UPDATE
    SET user_id = EXCLUDED.user_id,
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        user_agent = EXCLUDED.user_agent,
        last_used_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.claim_push_subscription(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_push_subscription(TEXT, TEXT, TEXT, TEXT) TO authenticated;