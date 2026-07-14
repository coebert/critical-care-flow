CREATE TABLE public.patient_scan_transfer (
  partner_patient_id text PRIMARY KEY,
  needs_scan_transfer boolean NOT NULL DEFAULT false,
  note text,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.patient_scan_transfer TO authenticated;
GRANT ALL ON public.patient_scan_transfer TO service_role;

ALTER TABLE public.patient_scan_transfer ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read scan transfer"
  ON public.patient_scan_transfer FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated can insert scan transfer"
  ON public.patient_scan_transfer FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated can update scan transfer"
  ON public.patient_scan_transfer FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);