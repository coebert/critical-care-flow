
-- Enum for predicted level of post-op support
DO $$ BEGIN
  CREATE TYPE public.postop_level AS ENUM ('level_1', 'level_2', 'level_3');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE public.postop_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Patient identifiers (encrypted; hashed for repeat-lookup)
  hospital_number_enc TEXT,
  hospital_number_hash TEXT,
  age INT CHECK (age IS NULL OR (age >= 0 AND age <= 130)),
  sex TEXT CHECK (sex IS NULL OR sex IN ('male','female','other','unknown')),
  weight_kg NUMERIC(6,2) CHECK (weight_kg IS NULL OR (weight_kg > 0 AND weight_kg < 500)),
  height_cm NUMERIC(6,2) CHECK (height_cm IS NULL OR (height_cm > 0 AND height_cm < 300)),
  bmi NUMERIC(5,2) CHECK (bmi IS NULL OR (bmi > 0 AND bmi < 200)),
  -- Clinical free-text (encrypted at rest)
  proposed_procedure_enc TEXT,
  past_medical_history_enc TEXT,
  past_surgical_history_enc TEXT,
  social_history_enc TEXT,
  reason_for_bed_enc TEXT,
  predicted_level public.postop_level NOT NULL,
  proposed_surgery_date DATE,
  -- Meta
  created_by UUID NOT NULL DEFAULT auth.uid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  deleted_by UUID
);

CREATE INDEX postop_bookings_created_at_idx ON public.postop_bookings (created_at DESC);
CREATE INDEX postop_bookings_hospital_hash_idx ON public.postop_bookings (hospital_number_hash);
CREATE INDEX postop_bookings_surgery_date_idx ON public.postop_bookings (proposed_surgery_date);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.postop_bookings TO authenticated;
GRANT ALL ON public.postop_bookings TO service_role;

ALTER TABLE public.postop_bookings ENABLE ROW LEVEL SECURITY;

-- Any clinician/admin may view non-deleted bookings
CREATE POLICY "Clinicians can view post-op bookings"
  ON public.postop_bookings FOR SELECT
  TO authenticated
  USING (
    deleted_at IS NULL
    AND public.has_clinical_access(auth.uid())
  );

CREATE POLICY "Clinicians can create post-op bookings"
  ON public.postop_bookings FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_clinical_access(auth.uid())
    AND created_by = auth.uid()
  );

CREATE POLICY "Clinicians can update post-op bookings"
  ON public.postop_bookings FOR UPDATE
  TO authenticated
  USING (public.has_clinical_access(auth.uid()))
  WITH CHECK (public.has_clinical_access(auth.uid()));

CREATE POLICY "Admins can delete post-op bookings"
  ON public.postop_bookings FOR DELETE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER postop_bookings_set_updated_at
BEFORE UPDATE ON public.postop_bookings
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
