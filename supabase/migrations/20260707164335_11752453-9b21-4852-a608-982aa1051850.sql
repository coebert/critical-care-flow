-- ================================================================
-- BEDS: static register
-- ================================================================
CREATE TYPE public.bed_unit AS ENUM ('icu', 'hdu');

CREATE TABLE public.beds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  unit public.bed_unit NOT NULL,
  is_side_room boolean NOT NULL DEFAULT false,
  notes text,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.beds TO authenticated;
GRANT ALL ON public.beds TO service_role;

ALTER TABLE public.beds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Clinical users read beds"
  ON public.beds FOR SELECT
  TO authenticated
  USING (public.has_clinical_access(auth.uid()));

CREATE POLICY "Admins insert beds"
  ON public.beds FOR INSERT
  TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins update beds"
  ON public.beds FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins delete beds"
  ON public.beds FOR DELETE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER set_beds_updated_at
  BEFORE UPDATE ON public.beds
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ================================================================
-- BED_OCCUPANCIES: who is in each bed
-- ================================================================
CREATE TYPE public.bed_isolation AS ENUM ('none','contact','droplet','airborne');
CREATE TYPE public.bed_step_down AS ENUM ('ward','hdu','home','other');

CREATE TABLE public.bed_occupancies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bed_id uuid NOT NULL REFERENCES public.beds(id) ON DELETE RESTRICT,
  hospital_number text,
  patient_initials text,
  admitting_consultant text,
  admitted_at timestamptz NOT NULL DEFAULT now(),
  discharged_at timestamptz,
  level smallint NOT NULL DEFAULT 3 CHECK (level BETWEEN 1 AND 3),
  ventilated boolean NOT NULL DEFAULT false,
  nippv_cpap boolean NOT NULL DEFAULT false,
  hfno boolean NOT NULL DEFAULT false,
  vasopressors boolean NOT NULL DEFAULT false,
  renal_replacement boolean NOT NULL DEFAULT false,
  tracheostomy boolean NOT NULL DEFAULT false,
  isolation public.bed_isolation NOT NULL DEFAULT 'none',
  isolation_reason text,
  requires_side_room boolean NOT NULL DEFAULT false,
  predicted_discharge_at timestamptz,
  predicted_step_down public.bed_step_down,
  actual_step_down public.bed_step_down,
  notes text,
  source_referral_id uuid REFERENCES public.referrals(id) ON DELETE SET NULL,
  source_postop_booking_id uuid REFERENCES public.postop_bookings(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id)
);

CREATE UNIQUE INDEX bed_occupancies_one_live_per_bed
  ON public.bed_occupancies (bed_id)
  WHERE discharged_at IS NULL;

CREATE INDEX bed_occupancies_bed_id_idx ON public.bed_occupancies (bed_id);
CREATE INDEX bed_occupancies_discharged_at_idx ON public.bed_occupancies (discharged_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.bed_occupancies TO authenticated;
GRANT ALL ON public.bed_occupancies TO service_role;

ALTER TABLE public.bed_occupancies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Clinical users read occupancies"
  ON public.bed_occupancies FOR SELECT
  TO authenticated
  USING (public.has_clinical_access(auth.uid()));

CREATE POLICY "Clinical users insert occupancies"
  ON public.bed_occupancies FOR INSERT
  TO authenticated
  WITH CHECK (public.has_clinical_access(auth.uid()) AND created_by = auth.uid());

CREATE POLICY "Clinical users update occupancies"
  ON public.bed_occupancies FOR UPDATE
  TO authenticated
  USING (public.has_clinical_access(auth.uid()))
  WITH CHECK (public.has_clinical_access(auth.uid()));

CREATE POLICY "Admins delete occupancies"
  ON public.bed_occupancies FOR DELETE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER set_bed_occupancies_updated_at
  BEFORE UPDATE ON public.bed_occupancies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ================================================================
-- BED_OUTLIERS: level-2 patients on the ward
-- ================================================================
CREATE TABLE public.bed_outliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_number text,
  patient_initials text,
  ward text NOT NULL,
  admitting_consultant text,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  level smallint NOT NULL DEFAULT 2 CHECK (level BETWEEN 1 AND 3),
  ventilated boolean NOT NULL DEFAULT false,
  nippv_cpap boolean NOT NULL DEFAULT false,
  hfno boolean NOT NULL DEFAULT false,
  vasopressors boolean NOT NULL DEFAULT false,
  renal_replacement boolean NOT NULL DEFAULT false,
  reason text,
  notes text,
  deleted_at timestamptz,
  deleted_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id)
);

CREATE INDEX bed_outliers_active_idx ON public.bed_outliers (ended_at) WHERE deleted_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.bed_outliers TO authenticated;
GRANT ALL ON public.bed_outliers TO service_role;

ALTER TABLE public.bed_outliers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Clinical users read outliers"
  ON public.bed_outliers FOR SELECT
  TO authenticated
  USING (public.has_clinical_access(auth.uid()));

CREATE POLICY "Clinical users insert outliers"
  ON public.bed_outliers FOR INSERT
  TO authenticated
  WITH CHECK (public.has_clinical_access(auth.uid()) AND created_by = auth.uid());

CREATE POLICY "Clinical users update outliers"
  ON public.bed_outliers FOR UPDATE
  TO authenticated
  USING (public.has_clinical_access(auth.uid()))
  WITH CHECK (public.has_clinical_access(auth.uid()));

CREATE POLICY "Admins delete outliers"
  ON public.bed_outliers FOR DELETE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER set_bed_outliers_updated_at
  BEFORE UPDATE ON public.bed_outliers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ================================================================
-- BED_TRANSFERS_OUT: repats + tertiary transfers
-- ================================================================
CREATE TYPE public.bed_transfer_kind AS ENUM ('repat','tertiary','other');
CREATE TYPE public.bed_transport_mode AS ENUM ('land_ambulance','air','self','other');
CREATE TYPE public.bed_transfer_status AS ENUM ('requested','accepted','awaiting_transport','in_transit','completed','cancelled');

CREATE TABLE public.bed_transfers_out (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occupancy_id uuid REFERENCES public.bed_occupancies(id) ON DELETE SET NULL,
  kind public.bed_transfer_kind NOT NULL DEFAULT 'repat',
  destination_hospital text NOT NULL,
  destination_specialty text,
  reason text,
  transport_mode public.bed_transport_mode,
  status public.bed_transfer_status NOT NULL DEFAULT 'requested',
  requested_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  eta_at timestamptz,
  departed_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  notes text,
  deleted_at timestamptz,
  deleted_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id)
);

CREATE INDEX bed_transfers_out_status_idx ON public.bed_transfers_out (status) WHERE deleted_at IS NULL;
CREATE INDEX bed_transfers_out_occupancy_idx ON public.bed_transfers_out (occupancy_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.bed_transfers_out TO authenticated;
GRANT ALL ON public.bed_transfers_out TO service_role;

ALTER TABLE public.bed_transfers_out ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Clinical users read transfers"
  ON public.bed_transfers_out FOR SELECT
  TO authenticated
  USING (public.has_clinical_access(auth.uid()));

CREATE POLICY "Clinical users insert transfers"
  ON public.bed_transfers_out FOR INSERT
  TO authenticated
  WITH CHECK (public.has_clinical_access(auth.uid()) AND created_by = auth.uid());

CREATE POLICY "Clinical users update transfers"
  ON public.bed_transfers_out FOR UPDATE
  TO authenticated
  USING (public.has_clinical_access(auth.uid()))
  WITH CHECK (public.has_clinical_access(auth.uid()));

CREATE POLICY "Admins delete transfers"
  ON public.bed_transfers_out FOR DELETE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER set_bed_transfers_out_updated_at
  BEFORE UPDATE ON public.bed_transfers_out
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ================================================================
-- Realtime
-- ================================================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.beds;
ALTER PUBLICATION supabase_realtime ADD TABLE public.bed_occupancies;
ALTER PUBLICATION supabase_realtime ADD TABLE public.bed_outliers;
ALTER PUBLICATION supabase_realtime ADD TABLE public.bed_transfers_out;

-- ================================================================
-- Seed: starter bed register (10 ICU + 6 HDU)
-- ================================================================
INSERT INTO public.beds (code, unit, is_side_room, sort_order) VALUES
  ('ICU-1', 'icu', false, 1),
  ('ICU-2', 'icu', false, 2),
  ('ICU-3', 'icu', false, 3),
  ('ICU-4', 'icu', false, 4),
  ('ICU-5', 'icu', true,  5),
  ('ICU-6', 'icu', true,  6),
  ('ICU-7', 'icu', false, 7),
  ('ICU-8', 'icu', false, 8),
  ('ICU-9', 'icu', false, 9),
  ('ICU-10','icu', false, 10),
  ('HDU-1', 'hdu', false, 20),
  ('HDU-2', 'hdu', false, 21),
  ('HDU-3', 'hdu', false, 22),
  ('HDU-4', 'hdu', false, 23),
  ('HDU-5', 'hdu', true,  24),
  ('HDU-6', 'hdu', false, 25);
