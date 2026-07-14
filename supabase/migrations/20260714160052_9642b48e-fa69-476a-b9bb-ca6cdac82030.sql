CREATE TABLE public.patient_end_of_life (
  partner_patient_id text PRIMARY KEY,
  end_of_life boolean NOT NULL DEFAULT false,
  note text,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.patient_end_of_life TO authenticated;
GRANT ALL ON public.patient_end_of_life TO service_role;

ALTER TABLE public.patient_end_of_life ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read end of life"
  ON public.patient_end_of_life FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated can insert end of life"
  ON public.patient_end_of_life FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated can update end of life"
  ON public.patient_end_of_life FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);