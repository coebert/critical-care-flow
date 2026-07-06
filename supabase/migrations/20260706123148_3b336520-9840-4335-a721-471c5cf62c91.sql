
-- 1. Harden handle_new_user: only admin-invited users get an automatic clinician role.
--    Self-registrations via /auth/v1/signup receive no role and cannot access
--    clinical data until an admin explicitly grants one via setUserRole.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  user_count INT;
BEGIN
  INSERT INTO public.profiles (id, full_name, job_title)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    NEW.raw_user_meta_data->>'job_title'
  );

  SELECT count(*) INTO user_count FROM auth.users;
  IF user_count = 1 THEN
    -- First user bootstraps as admin.
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'admin');
  ELSIF NEW.invited_at IS NOT NULL THEN
    -- Admin invite path (inviteUserByEmail) → default clinician role.
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'clinician');
  END IF;
  -- Self-signups (invited_at IS NULL, not first user) receive NO role.
  -- An admin must call setUserRole to grant access.

  RETURN NEW;
END;
$function$;

-- 2. Explicit ownership-bound policies for webauthn_credentials.
--    Registration is normally driven server-side (service_role bypasses RLS),
--    but these policies fail-close any direct client write path.
CREATE POLICY "Users can register their own passkeys"
  ON public.webauthn_credentials FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own passkeys"
  ON public.webauthn_credentials FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 3. Split the referrals UPDATE policy so shared triage on live rows stays
--    open to clinical staff, but any change touching deleted_at / deleted_by
--    (soft-delete or restore) requires the creator or an admin. The existing
--    prevent_unauthorized_soft_delete trigger continues to enforce this at
--    the row-transition level.
DROP POLICY IF EXISTS "Referrals updatable by clinical staff" ON public.referrals;

CREATE POLICY "Referrals live-row updates by clinical staff"
  ON public.referrals FOR UPDATE
  TO authenticated
  USING (
    has_clinical_access(auth.uid())
    AND deleted_at IS NULL
  )
  WITH CHECK (
    has_clinical_access(auth.uid())
    AND deleted_at IS NULL
    AND deleted_by IS NULL
  );

CREATE POLICY "Referrals soft-delete or restore by creator or admin"
  ON public.referrals FOR UPDATE
  TO authenticated
  USING (
    has_clinical_access(auth.uid())
    AND (auth.uid() = created_by OR has_role(auth.uid(), 'admin'::app_role))
  )
  WITH CHECK (
    has_clinical_access(auth.uid())
    AND (auth.uid() = created_by OR has_role(auth.uid(), 'admin'::app_role))
  );
