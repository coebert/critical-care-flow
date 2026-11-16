-- STAGED FOR REVIEW — NOT APPLIED. Apply in the coordinated release.
-- Forward-only, additive. Grants on existing functions are preserved by
-- CREATE OR REPLACE (snapshot_patient_acuity stays service_role-only).
--
-- 1. The database owns the acuity revision: updated_at moves strictly
--    forward on every write (even several in the same millisecond, and for
--    direct DML), so an old revision can never match a compare-and-set again.
-- 2. A signed-in caller's actor is always auth.uid(); only the trusted
--    service-role server path may supply updated_by.
-- 3. History and audit record the EFFECTIVE level (NULL when not recorded —
--    never the placeholder L1/L0) plus real 1:1 and level_recorded changes.

CREATE OR REPLACE FUNCTION public.manage_patient_acuity_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.updated_at := clock_timestamp();
  ELSE
    NEW.updated_at := GREATEST(clock_timestamp(), OLD.updated_at + interval '1 microsecond');
  END IF;
  IF current_user IN ('authenticated', 'anon') THEN
    NEW.updated_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_manage_patient_acuity_revision ON public.patient_acuity_overrides;
CREATE TRIGGER a_manage_patient_acuity_revision
  BEFORE INSERT OR UPDATE ON public.patient_acuity_overrides
  FOR EACH ROW EXECUTE FUNCTION public.manage_patient_acuity_revision();

-- History: add the real 1:1 value; 1:1-only changes get their own source so
-- the existing "levels scored" analytics (source = 'change') are unchanged.
ALTER TABLE public.patient_acuity_history ADD COLUMN IF NOT EXISTS one_to_one boolean;
COMMENT ON COLUMN public.patient_acuity_history.one_to_one IS
  '1:1 nursing flag at this point (NULL on rows written before it was tracked).';
ALTER TABLE public.patient_acuity_history
  DROP CONSTRAINT IF EXISTS patient_acuity_history_source_check,
  ADD CONSTRAINT patient_acuity_history_source_check
    CHECK (source = ANY (ARRAY['change'::text, 'snapshot'::text, 'one_to_one_change'::text]));

CREATE OR REPLACE FUNCTION public.log_patient_acuity_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_level smallint;
  old_level smallint;
  actor uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.patient_acuity_history (partner_patient_id, level, one_to_one, source, recorded_by)
    VALUES (OLD.partner_patient_id, NULL, false, 'change', auth.uid());
    RETURN OLD;
  END IF;
  actor := COALESCE(auth.uid(), NEW.updated_by);
  new_level := CASE WHEN NEW.level_recorded THEN NEW.level ELSE NULL END;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.patient_acuity_history (partner_patient_id, level, one_to_one, source, recorded_by)
    VALUES (NEW.partner_patient_id, new_level, NEW.one_to_one,
            CASE WHEN new_level IS NULL THEN 'one_to_one_change' ELSE 'change' END, actor);
    RETURN NEW;
  END IF;
  old_level := CASE WHEN OLD.level_recorded THEN OLD.level ELSE NULL END;
  IF new_level IS DISTINCT FROM old_level THEN
    INSERT INTO public.patient_acuity_history (partner_patient_id, level, one_to_one, source, recorded_by)
    VALUES (NEW.partner_patient_id, new_level, NEW.one_to_one, 'change', actor);
  ELSIF NEW.one_to_one IS DISTINCT FROM OLD.one_to_one THEN
    INSERT INTO public.patient_acuity_history (partner_patient_id, level, one_to_one, source, recorded_by)
    VALUES (NEW.partner_patient_id, new_level, NEW.one_to_one, 'one_to_one_change', actor);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.snapshot_patient_acuity()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inserted integer;
BEGIN
  INSERT INTO public.patient_acuity_history (partner_patient_id, level, one_to_one, source, recorded_by)
  SELECT partner_patient_id, CASE WHEN level_recorded THEN level ELSE NULL END, one_to_one, 'snapshot', NULL
  FROM public.patient_acuity_overrides;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END;
$$;

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
  old_eff smallint;
  new_eff smallint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    new_eff := CASE WHEN NEW.level_recorded THEN NEW.level ELSE NULL END;
    v_action := 'create';
    v_entity_id := NEW.partner_patient_id;
    v_actor := COALESCE(v_actor, NEW.updated_by);
    v_diff := jsonb_build_object(
      'partner_patient_id', NEW.partner_patient_id,
      'level', jsonb_build_object('old', NULL, 'new', new_eff),
      'one_to_one', jsonb_build_object('old', NULL, 'new', NEW.one_to_one),
      'level_recorded', jsonb_build_object('old', NULL, 'new', NEW.level_recorded)
    );
  ELSIF TG_OP = 'UPDATE' THEN
    old_eff := CASE WHEN OLD.level_recorded THEN OLD.level ELSE NULL END;
    new_eff := CASE WHEN NEW.level_recorded THEN NEW.level ELSE NULL END;
    IF new_eff IS NOT DISTINCT FROM old_eff
       AND NEW.one_to_one IS NOT DISTINCT FROM OLD.one_to_one
       AND NEW.level_recorded IS NOT DISTINCT FROM OLD.level_recorded THEN
      RETURN NEW;
    END IF;
    v_action := 'update';
    v_entity_id := NEW.partner_patient_id;
    v_actor := COALESCE(v_actor, NEW.updated_by);
    v_diff := jsonb_build_object(
      'partner_patient_id', NEW.partner_patient_id,
      'level', jsonb_build_object('old', old_eff, 'new', new_eff),
      'one_to_one', jsonb_build_object('old', OLD.one_to_one, 'new', NEW.one_to_one),
      'level_recorded', jsonb_build_object('old', OLD.level_recorded, 'new', NEW.level_recorded)
    );
  ELSIF TG_OP = 'DELETE' THEN
    old_eff := CASE WHEN OLD.level_recorded THEN OLD.level ELSE NULL END;
    v_action := 'delete';
    v_entity_id := OLD.partner_patient_id;
    v_diff := jsonb_build_object(
      'partner_patient_id', OLD.partner_patient_id,
      'level', jsonb_build_object('old', old_eff, 'new', NULL),
      'one_to_one', jsonb_build_object('old', OLD.one_to_one, 'new', NULL),
      'level_recorded', jsonb_build_object('old', OLD.level_recorded, 'new', NULL)
    );
  END IF;

  INSERT INTO public.audit_log (user_id, action, entity, entity_id, diff)
  VALUES (v_actor, v_action, 'patient_acuity', v_entity_id, v_diff);

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
