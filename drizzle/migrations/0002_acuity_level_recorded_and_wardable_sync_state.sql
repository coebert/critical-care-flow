ALTER TABLE public.patient_acuity_overrides
  ADD COLUMN IF NOT EXISTS level_recorded boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN public.patient_acuity_overrides.level_recorded IS
  'false = no level of care has been observed; the stored level is a placeholder (NOT NULL column) and must never be used as an observed level';

ALTER TABLE public.patient_wardable_status
  ADD COLUMN IF NOT EXISTS desired_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS partner_sync_status text,
  ADD COLUMN IF NOT EXISTS partner_sync_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS partner_synced_revision bigint;
ALTER TABLE public.patient_wardable_status
  DROP CONSTRAINT IF EXISTS patient_wardable_status_partner_sync_status_check;
ALTER TABLE public.patient_wardable_status
  ADD CONSTRAINT patient_wardable_status_partner_sync_status_check
  CHECK (partner_sync_status IS NULL OR partner_sync_status IN ('pending','synced','failed','not_configured','conflict','not_shared'));
COMMENT ON COLUMN public.patient_wardable_status.desired_revision IS
  'Incremented on every local wardable toggle; Hub sync outcomes are only recorded against the revision they pushed';

CREATE OR REPLACE FUNCTION public.log_patient_acuity_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  new_level smallint;
  old_level smallint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.patient_acuity_history
      (partner_patient_id, level, source, recorded_by)
    VALUES (OLD.partner_patient_id, NULL, 'change', auth.uid());
    RETURN OLD;
  END IF;
  new_level := CASE WHEN NEW.level_recorded THEN NEW.level ELSE NULL END;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.patient_acuity_history
      (partner_patient_id, level, source, recorded_by)
    VALUES (NEW.partner_patient_id, new_level, 'change', COALESCE(NEW.updated_by, auth.uid()));
    RETURN NEW;
  END IF;
  old_level := CASE WHEN OLD.level_recorded THEN OLD.level ELSE NULL END;
  IF new_level IS DISTINCT FROM old_level THEN
    INSERT INTO public.patient_acuity_history
      (partner_patient_id, level, source, recorded_by)
    VALUES (NEW.partner_patient_id, new_level, 'change', COALESCE(NEW.updated_by, auth.uid()));
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.snapshot_patient_acuity()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  inserted integer;
BEGIN
  INSERT INTO public.patient_acuity_history
    (partner_patient_id, level, source, recorded_by)
  SELECT partner_patient_id, CASE WHEN level_recorded THEN level ELSE NULL END, 'snapshot', NULL
  FROM public.patient_acuity_overrides;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END;
$function$;
REVOKE ALL ON FUNCTION public.snapshot_patient_acuity() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.snapshot_patient_acuity() TO service_role;