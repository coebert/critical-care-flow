
DROP POLICY IF EXISTS "Users manage own or claimed push subs - update" ON public.push_subscriptions;

CREATE POLICY "Users manage own push subs - update"
ON public.push_subscriptions
FOR UPDATE
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.claim_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;
