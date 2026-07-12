-- Add a one-to-one nursing flag to per-patient acuity overrides so a
-- patient can require dedicated nursing regardless of their care level.
ALTER TABLE public.patient_acuity_overrides
  ADD COLUMN IF NOT EXISTS one_to_one boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.patient_acuity_overrides.one_to_one IS
  'When true, patient requires 1:1 nursing regardless of level of care; forces dependency weight to 1.0 in unit calculations.';
