-- STAGED (not applied). Requires 0003_wardable_revision_fence.sql.
--
-- Reviewed re-confirmation of a wardable intent. Used only when the Hub has
-- already APPLIED the reviewed local revision and its value was changed
-- natively afterwards: re-sending that revision can never change the Hub
-- again, so the clinician's explicit, reviewed confirmation becomes a NEW
-- durable revision — allocated atomically and ONLY IF the local desired
-- revision and value are still exactly the reviewed ones.
--
-- Returns zero rows when the local state moved on (nothing is written).
-- The actor is always auth.uid(); revisions are returned as decimal text.

CREATE OR REPLACE FUNCTION public.confirm_wardable_reviewed_intent(
  _partner_patient_id text,
  _reviewed_revision text,
  _wardable boolean
)
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
  _reviewed bigint;
  _counter bigint;
  _cur bigint;
  _cur_wardable boolean;
  _rev bigint;
BEGIN
  IF _uid IS NULL OR NOT public.has_clinical_access(_uid) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF _partner_patient_id IS NULL
     OR _partner_patient_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'invalid patient id' USING ERRCODE = '22023';
  END IF;
  IF _reviewed_revision IS NULL OR _reviewed_revision !~ '^[1-9][0-9]{0,18}$' THEN
    RAISE EXCEPTION 'invalid reviewed revision' USING ERRCODE = '22023';
  END IF;
  IF _wardable IS NULL THEN
    RAISE EXCEPTION 'wardable is required' USING ERRCODE = '22023';
  END IF;
  _reviewed := _reviewed_revision::bigint;  -- > bigint max raises 22003
  _id := lower(_partner_patient_id);

  -- Same lock order as set_wardable_desired_state: counter, then overlay.
  SELECT c.last_revision INTO _counter
    FROM public.patient_wardable_revision_counters c
   WHERE c.partner_patient_id = _id
   FOR UPDATE;
  SELECT w.desired_revision, w.wardable INTO _cur, _cur_wardable
    FROM public.patient_wardable_status w
   WHERE w.partner_patient_id = _id
   FOR UPDATE;
  IF NOT FOUND OR _cur <> _reviewed OR _cur_wardable IS DISTINCT FROM _wardable THEN
    RETURN;  -- stale review: nothing written
  END IF;

  _rev := GREATEST(COALESCE(_counter, 0), _cur) + 1;
  INSERT INTO public.patient_wardable_revision_counters AS c (partner_patient_id, last_revision, updated_at)
  VALUES (_id, _rev, now())
  ON CONFLICT (partner_patient_id) DO UPDATE
    SET last_revision = EXCLUDED.last_revision, updated_at = now();

  UPDATE public.patient_wardable_status w
     SET desired_revision = _rev,
         partner_sync_status = 'pending',
         partner_sync_checked_at = NULL,
         updated_by = _uid
   WHERE w.partner_patient_id = _id;

  RETURN QUERY
    SELECT w.partner_patient_id, w.wardable, w.wardable_at, w.discharged_at, w.updated_at,
           w.desired_revision::text, w.partner_sync_status, w.partner_sync_checked_at,
           w.partner_synced_revision::text
    FROM public.patient_wardable_status w
    WHERE w.partner_patient_id = _id;
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_wardable_reviewed_intent(text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_wardable_reviewed_intent(text, text, boolean) TO authenticated, service_role;
