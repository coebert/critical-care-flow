DROP POLICY IF EXISTS "Referrals updatable by clinical staff" ON public.referrals;

CREATE POLICY "Referrals updatable by clinical staff" ON public.referrals
  FOR UPDATE TO authenticated
  USING (public.has_clinical_access(auth.uid()))
  WITH CHECK (
    public.has_clinical_access(auth.uid())
    AND (
      (deleted_at IS NULL AND deleted_by IS NULL)
      OR auth.uid() = created_by
      OR public.has_role(auth.uid(), 'admin'::app_role)
    )
  );