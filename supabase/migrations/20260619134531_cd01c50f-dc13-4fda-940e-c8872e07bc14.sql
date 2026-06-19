
-- Helper: user has any clinical role
CREATE OR REPLACE FUNCTION public.has_clinical_access(_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role IN ('admin','clinician')
  )
$$;
REVOKE EXECUTE ON FUNCTION public.has_clinical_access(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_clinical_access(uuid) TO authenticated, service_role;

-- Referrals: restrict SELECT/UPDATE to clinical staff
DROP POLICY IF EXISTS "Referrals readable by authenticated" ON public.referrals;
DROP POLICY IF EXISTS "Referrals updatable by authenticated" ON public.referrals;
DROP POLICY IF EXISTS "Referrals insertable by authenticated" ON public.referrals;
CREATE POLICY "Referrals readable by clinical staff" ON public.referrals
  FOR SELECT TO authenticated
  USING (public.has_clinical_access(auth.uid()));
CREATE POLICY "Referrals insertable by clinical staff" ON public.referrals
  FOR INSERT TO authenticated
  WITH CHECK (public.has_clinical_access(auth.uid()) AND auth.uid() = created_by);
CREATE POLICY "Referrals updatable by clinical staff" ON public.referrals
  FOR UPDATE TO authenticated
  USING (public.has_clinical_access(auth.uid()))
  WITH CHECK (public.has_clinical_access(auth.uid()));

-- Referral notes: restrict SELECT to clinical staff
DROP POLICY IF EXISTS "Notes readable by authenticated" ON public.referral_notes;
DROP POLICY IF EXISTS "Notes insertable by author" ON public.referral_notes;
CREATE POLICY "Notes readable by clinical staff" ON public.referral_notes
  FOR SELECT TO authenticated
  USING (public.has_clinical_access(auth.uid()));
CREATE POLICY "Notes insertable by author" ON public.referral_notes
  FOR INSERT TO authenticated
  WITH CHECK (public.has_clinical_access(auth.uid()) AND auth.uid() = author_id);

-- User roles: own row, or admins see all
DROP POLICY IF EXISTS "Roles readable by authenticated" ON public.user_roles;
CREATE POLICY "Roles readable by self or admin" ON public.user_roles
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- Audit log: remove client INSERT (server-only via service role)
DROP POLICY IF EXISTS "Audit insertable by authenticated" ON public.audit_log;

-- Notifications: remove client INSERT (server-only via service role)
DROP POLICY IF EXISTS "Notifications insertable by authenticated" ON public.notifications;

-- Profiles: tighten to clinical staff (was world-readable to authenticated)
DROP POLICY IF EXISTS "Profiles readable by authenticated" ON public.profiles;
CREATE POLICY "Profiles readable by clinical staff" ON public.profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = id OR public.has_clinical_access(auth.uid()));
