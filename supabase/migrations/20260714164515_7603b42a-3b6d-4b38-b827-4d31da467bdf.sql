
-- Restrict patient_end_of_life, patient_scan_transfer, patient_violence_risk to clinical staff
DROP POLICY IF EXISTS "Authenticated can read end of life" ON public.patient_end_of_life;
DROP POLICY IF EXISTS "Authenticated can insert end of life" ON public.patient_end_of_life;
DROP POLICY IF EXISTS "Authenticated can update end of life" ON public.patient_end_of_life;
CREATE POLICY "Clinical staff can read end of life" ON public.patient_end_of_life
  FOR SELECT TO authenticated USING (public.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can insert end of life" ON public.patient_end_of_life
  FOR INSERT TO authenticated WITH CHECK (public.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can update end of life" ON public.patient_end_of_life
  FOR UPDATE TO authenticated USING (public.has_clinical_access(auth.uid()))
  WITH CHECK (public.has_clinical_access(auth.uid()));

DROP POLICY IF EXISTS "Authenticated can read scan transfer" ON public.patient_scan_transfer;
DROP POLICY IF EXISTS "Authenticated can insert scan transfer" ON public.patient_scan_transfer;
DROP POLICY IF EXISTS "Authenticated can update scan transfer" ON public.patient_scan_transfer;
CREATE POLICY "Clinical staff can read scan transfer" ON public.patient_scan_transfer
  FOR SELECT TO authenticated USING (public.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can insert scan transfer" ON public.patient_scan_transfer
  FOR INSERT TO authenticated WITH CHECK (public.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can update scan transfer" ON public.patient_scan_transfer
  FOR UPDATE TO authenticated USING (public.has_clinical_access(auth.uid()))
  WITH CHECK (public.has_clinical_access(auth.uid()));

DROP POLICY IF EXISTS "Authenticated can read violence risk" ON public.patient_violence_risk;
DROP POLICY IF EXISTS "Authenticated can insert violence risk" ON public.patient_violence_risk;
DROP POLICY IF EXISTS "Authenticated can update violence risk" ON public.patient_violence_risk;
CREATE POLICY "Clinical staff can read violence risk" ON public.patient_violence_risk
  FOR SELECT TO authenticated USING (public.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can insert violence risk" ON public.patient_violence_risk
  FOR INSERT TO authenticated WITH CHECK (public.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can update violence risk" ON public.patient_violence_risk
  FOR UPDATE TO authenticated USING (public.has_clinical_access(auth.uid()))
  WITH CHECK (public.has_clinical_access(auth.uid()));

-- Add WITH CHECK to referral_tasks update policy
DROP POLICY IF EXISTS "Clinical staff can update tasks on live referrals" ON public.referral_tasks;
CREATE POLICY "Clinical staff can update tasks on live referrals" ON public.referral_tasks
  FOR UPDATE TO authenticated
  USING (
    public.has_clinical_access(auth.uid()) AND EXISTS (
      SELECT 1 FROM public.referrals r WHERE r.id = referral_tasks.referral_id AND r.deleted_at IS NULL
    )
  )
  WITH CHECK (
    public.has_clinical_access(auth.uid()) AND EXISTS (
      SELECT 1 FROM public.referrals r WHERE r.id = referral_tasks.referral_id AND r.deleted_at IS NULL
    )
  );
