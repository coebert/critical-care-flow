-- STAGED FOR REVIEW — NOT APPLIED. Apply only in the coordinated CCC + Hub
-- release. Forward-only, additive. Verified against a disposable Postgres by
-- drizzle/staged/checks/0003_check.sh (synthetic data only).
--
-- Wardable desired-state revisions:
--  * Patient ids are canonical lowercase UUID text everywhere (preflight
--    below refuses to run if that would merge or rewrite unclear rows).
--  * A durable per-patient counter, separate from the deletable overlay
--    row, so a revision is never reset, reused or decreased after overlay
--    deletion/recreation or outbox cleanup. Nobody but the allocator
--    function can write it; delete/truncate/key rewrite/decrease are refused.
--  * set_wardable_desired_state() is the only way to change wardable state:
--    actor = auth.uid(), counter row locked first, then the overlay row.
--  * Revisions are bigint in storage but always EXPOSED AS TEXT (the RPC
--    result and patient_wardable_status_v), because JSON numbers above
--    2^53 lose precision in JavaScript.
--  * Direct DML by authenticated/anon/service_role cannot set wardable,
--    revisions, the key or a different actor; service_role may only record
--    sync outcomes for a revision that already exists.

-- 1. Preflight: canonical patient identity --------------------------------
DO $$
DECLARE _bad int; _dupes int;
BEGIN
  SELECT count(*) INTO _bad FROM public.patient_wardable_status
  WHERE partner_patient_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  IF _bad > 0 THEN
    RAISE EXCEPTION 'patient_wardable_status has % row(s) whose id is not a UUID; review them before applying', _bad;
  END IF;
  SELECT count(*) INTO _dupes FROM (
    SELECT lower(partner_patient_id) FROM public.patient_wardable_status
    GROUP BY lower(partner_patient_id) HAVING count(*) > 1) d;
  IF _dupes > 0 THEN
    RAISE EXCEPTION 'patient_wardable_status has % id(s) that differ only by letter case; review them before applying (rows are never merged automatically)', _dupes;
  END IF;
END $$;

UPDATE public.patient_wardable_status
SET partner_patient_id = lower(partner_patient_id)
WHERE partner_patient_id <> lower(partner_patient_id);

ALTER TABLE public.patient_wardable_status
  ADD CONSTRAINT patient_wardable_status_canonical_id
  CHECK (partner_patient_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
ALTER TABLE public.patient_wardable_status
  ADD CONSTRAINT patient_wardable_status_synced_le_desired
  CHECK (partner_synced_revision IS NULL OR (partner_synced_revision >= 0 AND partner_synced_revision <= desired_revision)) NOT VALID;

-- 2. Durable counter ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.patient_wardable_revision_counters (
  partner_patient_id text PRIMARY KEY
    CHECK (partner_patient_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  last_revision bigint NOT NULL DEFAULT 0 CHECK (last_revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.patient_wardable_revision_counters IS
  'Durable, never-reset wardable desired_revision allocator (one row per canonical Hub patient id). Written only by set_wardable_desired_state.';

INSERT INTO public.patient_wardable_revision_counters (partner_patient_id, last_revision)
SELECT partner_patient_id, max(desired_revision)
FROM public.patient_wardable_status
GROUP BY partner_patient_id
ON CONFLICT (partner_patient_id) DO UPDATE
  SET last_revision = GREATEST(public.patient_wardable_revision_counters.last_revision, EXCLUDED.last_revision);

REVOKE ALL ON public.patient_wardable_revision_counters FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.patient_wardable_revision_counters TO service_role;
ALTER TABLE public.patient_wardable_revision_counters ENABLE ROW LEVEL SECURITY;
-- No policies: only the SECURITY DEFINER allocator writes it.

CREATE OR REPLACE FUNCTION public.guard_wardable_revision_counter()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'wardable revision counters are permanent' USING ERRCODE = '42501';
  END IF;
  IF NEW.partner_patient_id IS DISTINCT FROM OLD.partner_patient_id THEN
    RAISE EXCEPTION 'wardable revision counter key cannot change' USING ERRCODE = '42501';
  END IF;
  IF NEW.last_revision < OLD.last_revision THEN
    RAISE EXCEPTION 'wardable revision counter cannot decrease' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guard_wardable_revision_counter_row ON public.patient_wardable_revision_counters;
CREATE TRIGGER guard_wardable_revision_counter_row
  BEFORE UPDATE OR DELETE ON public.patient_wardable_revision_counters
  FOR EACH ROW EXECUTE FUNCTION public.guard_wardable_revision_counter();
DROP TRIGGER IF EXISTS guard_wardable_revision_counter_truncate ON public.patient_wardable_revision_counters;
CREATE TRIGGER guard_wardable_revision_counter_truncate
  BEFORE TRUNCATE ON public.patient_wardable_revision_counters
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_wardable_revision_counter();

-- 3. Guard direct DML on the overlay --------------------------------------
CREATE OR REPLACE FUNCTION public.guard_wardable_direct_dml()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon', 'service_role') THEN
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
         OR NEW.partner_patient_id IS DISTINCT FROM OLD.partner_patient_id THEN
        RAISE EXCEPTION 'wardable state can only be changed through set_wardable_desired_state'
          USING ERRCODE = '42501';
      END IF;
      IF current_user <> 'service_role' AND (
           NEW.partner_sync_status IS DISTINCT FROM OLD.partner_sync_status
           OR NEW.partner_synced_revision IS DISTINCT FROM OLD.partner_synced_revision
           OR NEW.partner_sync_checked_at IS DISTINCT FROM OLD.partner_sync_checked_at) THEN
        RAISE EXCEPTION 'sync outcomes are recorded by the server only' USING ERRCODE = '42501';
      END IF;
    END IF;
    IF current_user <> 'service_role' THEN
      -- The actor is always the signed-in user, never a supplied value.
      NEW.updated_by := auth.uid();
    ELSIF TG_OP = 'UPDATE' THEN
      NEW.updated_by := OLD.updated_by;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_guard_wardable_direct_dml ON public.patient_wardable_status;
CREATE TRIGGER a_guard_wardable_direct_dml
  BEFORE INSERT OR UPDATE ON public.patient_wardable_status
  FOR EACH ROW EXECUTE FUNCTION public.guard_wardable_direct_dml();

-- 4. Allocator ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_wardable_desired_state(_partner_patient_id text, _wardable boolean)
RETURNS TABLE (
  partner_patient_id text,
  wardable boolean,
  wardable_at timestamptz,
  discharged_at timestamptz,
  updated_at timestamptz,
  desired_revision text,
  partner_sync_status text,
  partner_sync_checked_at timestamptz,
  partner_synced_revision text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  _uid uuid := auth.uid();
  _id text;
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
  -- Canonical identity BEFORE any read/write.
  _id := lower(_partner_patient_id);

  -- Lock order: counter row, then overlay row. The counter lock serialises
  -- concurrent toggles for this patient until commit.
  INSERT INTO public.patient_wardable_revision_counters AS c (partner_patient_id, last_revision, updated_at)
  VALUES (_id, 1, now())
  ON CONFLICT (partner_patient_id) DO UPDATE
    SET last_revision = c.last_revision + 1, updated_at = now()
  RETURNING c.last_revision INTO _rev;

  INSERT INTO public.patient_wardable_status AS w
    (partner_patient_id, wardable, wardable_at, discharged_at, updated_by,
     desired_revision, partner_sync_status, partner_sync_checked_at)
  VALUES
    (_id, _wardable, CASE WHEN _wardable THEN now() END, NULL, _uid,
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
           w.desired_revision::text, w.partner_sync_status, w.partner_sync_checked_at,
           w.partner_synced_revision::text
    FROM public.patient_wardable_status w
    WHERE w.partner_patient_id = _id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_wardable_desired_state(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_wardable_desired_state(text, boolean) TO authenticated, service_role;

-- 5. Lossless read projection (security invoker: caller's RLS applies) ----
CREATE OR REPLACE VIEW public.patient_wardable_status_v
WITH (security_invoker = true) AS
SELECT partner_patient_id, wardable, wardable_at, discharged_at, updated_at,
       desired_revision::text AS desired_revision,
       partner_sync_status, partner_sync_checked_at,
       partner_synced_revision::text AS partner_synced_revision
FROM public.patient_wardable_status;
COMMENT ON VIEW public.patient_wardable_status_v IS
  'Wardable overlay with revisions as canonical decimal text (no JSON number precision loss).';
REVOKE ALL ON public.patient_wardable_status_v FROM PUBLIC, anon;
GRANT SELECT ON public.patient_wardable_status_v TO authenticated, service_role;

-- Outcome recording is a service_role UPDATE of partner_sync_* filtered by
-- the exact desired_revision text (src/lib/wardable-status.server.ts).
