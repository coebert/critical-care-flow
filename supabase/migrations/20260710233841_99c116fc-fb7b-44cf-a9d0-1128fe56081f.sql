
CREATE TABLE public.patient_acuity_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_patient_id uuid NOT NULL,
  level smallint NULL,
  source text NOT NULL CHECK (source IN ('change','snapshot')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid NULL
);

CREATE INDEX patient_acuity_history_recorded_at_idx
  ON public.patient_acuity_history (recorded_at DESC);
CREATE INDEX patient_acuity_history_patient_idx
  ON public.patient_acuity_history (partner_patient_id, recorded_at DESC);

GRANT SELECT ON public.patient_acuity_history TO authenticated;
GRANT ALL ON public.patient_acuity_history TO service_role;

ALTER TABLE public.patient_acuity_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Clinicians can read acuity history"
  ON public.patient_acuity_history
  FOR SELECT
  TO authenticated
  USING (public.has_clinical_access(auth.uid()));

-- Trigger: log every change to patient_acuity_overrides
CREATE OR REPLACE FUNCTION public.log_patient_acuity_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.patient_acuity_history
      (partner_patient_id, level, source, recorded_by)
    VALUES (OLD.partner_patient_id, NULL, 'change', auth.uid());
    RETURN OLD;
  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO public.patient_acuity_history
      (partner_patient_id, level, source, recorded_by)
    VALUES (NEW.partner_patient_id, NEW.level, 'change', COALESCE(NEW.updated_by, auth.uid()));
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' AND NEW.level IS DISTINCT FROM OLD.level THEN
    INSERT INTO public.patient_acuity_history
      (partner_patient_id, level, source, recorded_by)
    VALUES (NEW.partner_patient_id, NEW.level, 'change', COALESCE(NEW.updated_by, auth.uid()));
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER patient_acuity_overrides_log_changes
AFTER INSERT OR UPDATE OR DELETE ON public.patient_acuity_overrides
FOR EACH ROW EXECUTE FUNCTION public.log_patient_acuity_change();

-- Snapshot function: writes one history row per current override
CREATE OR REPLACE FUNCTION public.snapshot_patient_acuity()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inserted integer;
BEGIN
  INSERT INTO public.patient_acuity_history
    (partner_patient_id, level, source, recorded_by)
  SELECT partner_patient_id, level, 'snapshot', NULL
  FROM public.patient_acuity_overrides;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END;
$$;
