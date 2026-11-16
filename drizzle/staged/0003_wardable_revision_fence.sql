-- STAGED FOR REVIEW — NOT APPLIED. Apply only in the coordinated CCC + Hub
-- release (after Hub ships POST /patients/wardable). Forward-only, additive.
--
-- Wardable desired-state revisions:
--  * A durable per-patient counter, separate from the deletable overlay row,
--    so a revision is never reset or reused after the overlay row is deleted
--    and recreated or after outbox cleanup.
--  * The only way for a signed-in clinician to change wardable state is
--    set_wardable_desired_state(), which derives the actor from auth.uid(),
--    allocates the next revision under a row lock (serialising concurrent
--    toggles for one patient) and marks the outbox row pending.
--  * Direct DML from authenticated/anon cannot set wardable, revisions,
--    sync outcome or a different actor. Discharge-timing stamps remain
--    directly editable (local analytics only).

CREATE TABLE IF NOT EXISTS public.patient_wardable_revision_counters (
  partner_patient_id text PRIMARY KEY,
  last_revision bigint NOT NULL DEFAULT 0 CHECK (last_revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.patient_wardable_revision_counters IS
  'Durable, never-reset wardable desired_revision allocator (one row per Hub patient id). Not deleted with the overlay.';
GRANT ALL ON public.patient_wardable_revision_counters TO service_role;
ALTER TABLE public.patient_wardable_revision_counters ENABLE ROW LEVEL SECURITY;
-- No policies: only SECURITY DEFINER functions and service_role touch it.

INSERT INTO public.patient_wardable_revision_counters (partner_patient_id, last_revision)
SELECT partner_patient_id, max(desired_revision)
FROM public.patient_wardable_status
GROUP BY partner_patient_id
ON CONFLICT (partner_patient_id) DO UPDATE
  SET last_revision = GREATEST(public.patient_wardable_revision_counters.last_revision, EXCLUDED.last_revision);

-- Guard direct DML by signed-in users.
CREATE OR REPLACE FUNCTION public.guard_wardable_direct_dml()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.wardable IS TRUE
         OR COALESCE(NEW.desired_revision, 0) <> 0
         OR NEW.partner_sync_status IS NOT NULL
         OR NEW.partner_synced_revision IS NOT NULL
         OR NEW.partner_sync_checked_at IS NOT NULL THEN
        RAISE EXCEPTION 'wardable state can only be changed through set_wardable_desired_state'
          USING ERRCODE = '42501';
      END IF;
    ELSIF TG_OP = 'UPDATE' THEN
      IF NEW.wardable IS DISTINCT FROM OLD.wardable
         OR NEW.wardable_at IS DISTINCT FROM OLD.wardable_at
         OR NEW.desired_revision IS DISTINCT FROM OLD.desired_revision
         OR NEW.partner_sync_status IS DISTINCT FROM OLD.partner_sync_status
         OR NEW.partner_synced_revision IS DISTINCT FROM OLD.partner_synced_revision
         OR NEW.partner_sync_checked_at IS DISTINCT FROM OLD.partner_sync_checked_at
         OR NEW.partner_patient_id IS DISTINCT FROM OLD.partner_patient_id THEN
        RAISE EXCEPTION 'wardable state can only be changed through set_wardable_desired_state'
          USING ERRCODE = '42501';
      END IF;
    END IF;
    -- The actor is always the signed-in user, never a supplied value.
    NEW.updated_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_guard_wardable_direct_dml ON public.patient_wardable_status;
CREATE TRIGGER a_guard_wardable_direct_dml
  BEFORE INSERT OR UPDATE ON public.patient_wardable_status
  FOR EACH ROW EXECUTE FUNCTION public.guard_wardable_direct_dml();

CREATE OR REPLACE FUNCTION public.set_wardable_desired_state(_partner_patient_id text, _wardable boolean)
RETURNS TABLE (
  partner_patient_id text,
  wardable boolean,
  wardable_at timestamptz,
  discharged_at timestamptz,
  updated_at timestamptz,
  desired_revision bigint,
  partner_sync_status text,
  partner_sync_checked_at timestamptz,
  partner_synced_revision bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  _uid uuid := auth.uid();
  _rev bigint;
BEGIN
  IF _uid IS NULL OR NOT public.has_clinical_access(_uid) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF _partner_patient_id IS NULL
     OR _partner_patient_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'invalid patient id' USING ERRCODE = '22023';
  END IF;
  IF _wardable IS NULL THEN
    RAISE EXCEPTION 'wardable is required' USING ERRCODE = '22023';
  END IF;

  -- Allocate the next revision; the counter row lock serialises concurrent
  -- toggles for this patient until commit.
  INSERT INTO public.patient_wardable_revision_counters AS c (partner_patient_id, last_revision, updated_at)
  VALUES (_partner_patient_id, 1, now())
  ON CONFLICT (partner_patient_id) DO UPDATE
    SET last_revision = c.last_revision + 1, updated_at = now()
  RETURNING c.last_revision INTO _rev;

  INSERT INTO public.patient_wardable_status AS w
    (partner_patient_id, wardable, wardable_at, discharged_at, updated_by,
     desired_revision, partner_sync_status, partner_sync_checked_at)
  VALUES
    (_partner_patient_id, _wardable, CASE WHEN _wardable THEN now() END, NULL, _uid,
     _rev, 'pending', NULL)
  ON CONFLICT ON CONSTRAINT patient_wardable_status_pkey DO UPDATE
    SET wardable = EXCLUDED.wardable,
        wardable_at = CASE
          WHEN EXCLUDED.wardable AND w.wardable THEN COALESCE(w.wardable_at, now())
          WHEN EXCLUDED.wardable THEN now()
          ELSE NULL END,
        discharged_at = NULL,
        updated_by = _uid,
        desired_revision = _rev,
        partner_sync_status = 'pending',
        partner_sync_checked_at = NULL;

  RETURN QUERY
    SELECT w.partner_patient_id, w.wardable, w.wardable_at, w.discharged_at, w.updated_at,
           w.desired_revision, w.partner_sync_status, w.partner_sync_checked_at, w.partner_synced_revision
    FROM public.patient_wardable_status w
    WHERE w.partner_patient_id = _partner_patient_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_wardable_desired_state(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_wardable_desired_state(text, boolean) TO authenticated, service_role;

-- Outcome recording stays a service_role UPDATE ... WHERE desired_revision = <pushed>
-- (src/lib/wardable-status.server.ts); service_role passes the guard above.
