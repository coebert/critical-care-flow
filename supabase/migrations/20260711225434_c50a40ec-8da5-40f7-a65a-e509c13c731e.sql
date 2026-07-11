CREATE OR REPLACE FUNCTION public.claim_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_user_agent text DEFAULT NULL::text
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_existing_owner UUID;
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

  -- Detect takeover attempts BEFORE touching the row. Web-push endpoints are
  -- opaque but not secret: they can leak via logs, backups, or a compromised
  -- device. Do not treat knowledge of an endpoint as proof of ownership.
  SELECT user_id INTO v_existing_owner
    FROM public.push_subscriptions
   WHERE endpoint = p_endpoint
   LIMIT 1;

  IF v_existing_owner IS NOT NULL AND v_existing_owner <> v_user_id THEN
    INSERT INTO public.audit_log (user_id, action, entity, entity_id, diff)
    VALUES (
      v_user_id,
      'update',
      'push_subscription_takeover_denied',
      v_user_id,
      jsonb_build_object(
        'existing_owner', v_existing_owner,
        'endpoint_prefix', left(p_endpoint, 64)
      )
    );
    RAISE EXCEPTION 'This push endpoint is already registered to another account'
      USING ERRCODE = '42501';
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
    SET p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        user_agent = EXCLUDED.user_agent,
        last_used_at = now()
    WHERE public.push_subscriptions.user_id = EXCLUDED.user_id;
END;
$function$;