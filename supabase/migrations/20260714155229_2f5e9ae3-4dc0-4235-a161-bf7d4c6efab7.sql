ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS airway_type text;

COMMENT ON COLUMN public.patients.airway_type IS
  'Airway management type mirrored from the partner ICU Handover Hub (e.g. own, ett, tracheostomy). Used by the bed board to render a tracheostomy indicator.';