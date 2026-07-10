
CREATE OR REPLACE FUNCTION public.audit_patient_acuity_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_action audit_action;
  v_actor uuid := auth.uid();
  v_entity_id uuid;
  v_diff jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'create';
    v_entity_id := NEW.partner_patient_id;
    v_actor := COALESCE(NEW.updated_by, v_actor);
    v_diff := jsonb_build_object(
      'partner_patient_id', NEW.partner_patient_id,
      'level', jsonb_build_object('old', NULL, 'new', NEW.level)
    );
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.level IS NOT DISTINCT FROM OLD.level THEN
      RETURN NEW;
    END IF;
    v_action := 'update';
    v_entity_id := NEW.partner_patient_id;
    v_actor := COALESCE(NEW.updated_by, v_actor);
    v_diff := jsonb_build_object(
      'partner_patient_id', NEW.partner_patient_id,
      'level', jsonb_build_object('old', OLD.level, 'new', NEW.level)
    );
  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'delete';
    v_entity_id := OLD.partner_patient_id;
    v_diff := jsonb_build_object(
      'partner_patient_id', OLD.partner_patient_id,
      'level', jsonb_build_object('old', OLD.level, 'new', NULL)
    );
  END IF;

  INSERT INTO public.audit_log (user_id, action, entity, entity_id, diff)
  VALUES (v_actor, v_action, 'patient_acuity', v_entity_id, v_diff);

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS patient_acuity_overrides_audit ON public.patient_acuity_overrides;
CREATE TRIGGER patient_acuity_overrides_audit
AFTER INSERT OR UPDATE OR DELETE ON public.patient_acuity_overrides
FOR EACH ROW EXECUTE FUNCTION public.audit_patient_acuity_change();
