
DROP POLICY IF EXISTS "Authenticated can view patients" ON public.patients;
DROP POLICY IF EXISTS "Authenticated can insert patients" ON public.patients;
DROP POLICY IF EXISTS "Authenticated can update patients" ON public.patients;
DROP POLICY IF EXISTS "Authenticated can delete patients" ON public.patients;

CREATE POLICY "Clinical staff can view patients" ON public.patients
  FOR SELECT TO authenticated USING (public.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can insert patients" ON public.patients
  FOR INSERT TO authenticated WITH CHECK (public.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can update patients" ON public.patients
  FOR UPDATE TO authenticated USING (public.has_clinical_access(auth.uid())) WITH CHECK (public.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can delete patients" ON public.patients
  FOR DELETE TO authenticated USING (public.has_clinical_access(auth.uid()));

DROP POLICY IF EXISTS "Authenticated can view investigations" ON public.investigations;
DROP POLICY IF EXISTS "Authenticated can insert investigations" ON public.investigations;
DROP POLICY IF EXISTS "Authenticated can update investigations" ON public.investigations;
DROP POLICY IF EXISTS "Authenticated can delete investigations" ON public.investigations;

CREATE POLICY "Clinical staff can view investigations" ON public.investigations
  FOR SELECT TO authenticated USING (public.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can insert investigations" ON public.investigations
  FOR INSERT TO authenticated WITH CHECK (public.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can update investigations" ON public.investigations
  FOR UPDATE TO authenticated USING (public.has_clinical_access(auth.uid())) WITH CHECK (public.has_clinical_access(auth.uid()));
CREATE POLICY "Clinical staff can delete investigations" ON public.investigations
  FOR DELETE TO authenticated USING (public.has_clinical_access(auth.uid()));
