CREATE TABLE public.patient_acuity_overrides (
  partner_patient_id uuid PRIMARY KEY,
  level smallint NOT NULL CHECK (level BETWEEN 0 AND 3),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.patient_acuity_overrides TO authenticated;
GRANT ALL ON public.patient_acuity_overrides TO service_role;
ALTER TABLE public.patient_acuity_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY "clinical users read acuity" ON public.patient_acuity_overrides FOR SELECT TO authenticated USING (public.has_clinical_access(auth.uid()));
CREATE POLICY "clinical users insert acuity" ON public.patient_acuity_overrides FOR INSERT TO authenticated WITH CHECK (public.has_clinical_access(auth.uid()));
CREATE POLICY "clinical users update acuity" ON public.patient_acuity_overrides FOR UPDATE TO authenticated USING (public.has_clinical_access(auth.uid())) WITH CHECK (public.has_clinical_access(auth.uid()));
CREATE POLICY "clinical users delete acuity" ON public.patient_acuity_overrides FOR DELETE TO authenticated USING (public.has_clinical_access(auth.uid()));