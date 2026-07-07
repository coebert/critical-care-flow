
CREATE TABLE public.nurse_staffing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_date date NOT NULL,
  shift text NOT NULL CHECK (shift IN ('day','night')),
  available_nurses numeric(4,1) NOT NULL CHECK (available_nurses >= 0 AND available_nurses <= 200),
  notes text,
  recorded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shift_date, shift)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.nurse_staffing TO authenticated;
GRANT ALL ON public.nurse_staffing TO service_role;

ALTER TABLE public.nurse_staffing ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Clinical users read nurse staffing"
  ON public.nurse_staffing FOR SELECT
  TO authenticated
  USING (public.has_clinical_access(auth.uid()));

CREATE POLICY "Clinical users insert nurse staffing"
  ON public.nurse_staffing FOR INSERT
  TO authenticated
  WITH CHECK (public.has_clinical_access(auth.uid()));

CREATE POLICY "Clinical users update nurse staffing"
  ON public.nurse_staffing FOR UPDATE
  TO authenticated
  USING (public.has_clinical_access(auth.uid()))
  WITH CHECK (public.has_clinical_access(auth.uid()));

CREATE POLICY "Admins delete nurse staffing"
  ON public.nurse_staffing FOR DELETE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER set_nurse_staffing_updated_at
  BEFORE UPDATE ON public.nurse_staffing
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX idx_nurse_staffing_shift_date ON public.nurse_staffing (shift_date DESC, shift);
