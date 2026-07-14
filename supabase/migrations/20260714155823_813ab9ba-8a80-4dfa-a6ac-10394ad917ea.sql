CREATE TABLE public.patient_violence_risk (
  partner_patient_id text PRIMARY KEY,
  violence_risk boolean NOT NULL DEFAULT false,
  note text,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.patient_violence_risk TO authenticated;
GRANT ALL ON public.patient_violence_risk TO service_role;

ALTER TABLE public.patient_violence_risk ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read violence risk"
  ON public.patient_violence_risk FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated can insert violence risk"
  ON public.patient_violence_risk FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated can update violence risk"
  ON public.patient_violence_risk FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);