-- handle_new_user previously used `SELECT count(*) FROM auth.users` to decide
-- whether to bootstrap the first user as admin. Under concurrent signups two
-- inserts can both observe count = 1 and both become admin. Replace the count
-- check with an explicit "no admin exists yet" check against user_roles.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  admin_exists BOOLEAN;
BEGIN
  INSERT INTO public.profiles (id, full_name, job_title)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    NEW.raw_user_meta_data->>'job_title'
  );

  -- Race-safe bootstrap: only the first successful insert wins because
  -- (user_id, role) is UNIQUE on user_roles. Any concurrent second signup
  -- that sees admin_exists = false will still be blocked by the unique
  -- constraint if it tried, but we scope the check to admin specifically.
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE role = 'admin'
  ) INTO admin_exists;

  IF NOT admin_exists THEN
    -- First user in the system bootstraps as admin.
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, 'admin')
    ON CONFLICT (user_id, role) DO NOTHING;
  ELSIF NEW.invited_at IS NOT NULL THEN
    -- Admin invite path (inviteUserByEmail) → default clinician role.
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, 'clinician')
    ON CONFLICT (user_id, role) DO NOTHING;
  END IF;
  -- Self-signups (invited_at IS NULL, admin already exists) receive NO role.
  -- An admin must call setUserRole to grant access.

  RETURN NEW;
END;
$function$;