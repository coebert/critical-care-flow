
-- Enums used by the ICU Handover Hub schema
DO $$ BEGIN
  CREATE TYPE public.patient_location AS ENUM ('icu', 'outlier');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.patient_status AS ENUM ('referred', 'admitted', 'discharged', 'died');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- PATIENTS (shared with ICU Handover Hub)
CREATE TABLE public.patients (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_by UUID REFERENCES auth.users(id),
  updated_by UUID REFERENCES auth.users(id),
  full_name TEXT NOT NULL,
  hospital_number TEXT,
  nhs_number TEXT,
  dob DATE,
  location_type public.patient_location NOT NULL DEFAULT 'icu',
  ward TEXT,
  bed TEXT,
  status public.patient_status NOT NULL DEFAULT 'admitted',
  admission_date DATE,
  discharge_date DATE,
  discharge_destination TEXT,
  date_of_death DATE,
  past_medical_history TEXT,
  current_admission TEXT,
  current_management TEXT,
  outstanding_tasks TEXT,
  tep_in_place BOOLEAN NOT NULL DEFAULT false,
  tep_details TEXT,
  dnacpr_decision BOOLEAN NOT NULL DEFAULT false,
  dnacpr_details TEXT,
  dnacpr_date DATE,
  nok_name TEXT,
  nok_relationship TEXT,
  nok_contact TEXT,
  nok_last_updated TIMESTAMPTZ,
  nok_last_updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.patients TO authenticated;
GRANT ALL ON public.patients TO service_role;
ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can view patients" ON public.patients
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert patients" ON public.patients
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update patients" ON public.patients
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete patients" ON public.patients
  FOR DELETE TO authenticated USING (true);
CREATE TRIGGER update_patients_updated_at
  BEFORE UPDATE ON public.patients
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE INDEX idx_patients_status ON public.patients(status);

-- INVESTIGATIONS
CREATE TABLE public.investigations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  findings TEXT NOT NULL,
  result_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.investigations TO authenticated;
GRANT ALL ON public.investigations TO service_role;
ALTER TABLE public.investigations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can view investigations" ON public.investigations
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert investigations" ON public.investigations
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update investigations" ON public.investigations
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete investigations" ON public.investigations
  FOR DELETE TO authenticated USING (true);
CREATE TRIGGER update_investigations_updated_at
  BEFORE UPDATE ON public.investigations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE INDEX idx_investigations_patient
  ON public.investigations(patient_id, category, result_at DESC);

-- Link bed occupancies to shared patient records (nullable — legacy rows keep working)
ALTER TABLE public.bed_occupancies
  ADD COLUMN patient_id UUID REFERENCES public.patients(id) ON DELETE SET NULL;
CREATE INDEX idx_bed_occupancies_patient ON public.bed_occupancies(patient_id);
