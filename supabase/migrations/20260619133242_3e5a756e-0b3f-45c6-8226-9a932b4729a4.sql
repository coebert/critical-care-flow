
-- Tighten permissive policies
DROP POLICY "Referrals insertable by authenticated" ON public.referrals;
CREATE POLICY "Referrals insertable by authenticated" ON public.referrals
  FOR INSERT TO authenticated WITH CHECK (auth.uid() IS NOT NULL);

DROP POLICY "Referrals updatable by authenticated" ON public.referrals;
CREATE POLICY "Referrals updatable by authenticated" ON public.referrals
  FOR UPDATE TO authenticated USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);

DROP POLICY "Notifications insertable by authenticated" ON public.notifications;
CREATE POLICY "Notifications insertable by authenticated" ON public.notifications
  FOR INSERT TO authenticated WITH CHECK (auth.uid() IS NOT NULL);

-- Lock down SECURITY DEFINER functions
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.has_role(UUID, public.app_role) FROM PUBLIC, anon;
-- authenticated still needs has_role for RLS evaluation (via policies); allow it
GRANT EXECUTE ON FUNCTION public.has_role(UUID, public.app_role) TO authenticated, service_role;
-- set_updated_at is SECURITY INVOKER by default; ensure no SECURITY DEFINER exposure
REVOKE EXECUTE ON FUNCTION public.set_updated_at() FROM PUBLIC, anon, authenticated;
