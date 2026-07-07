
-- 1) Enums
DO $$ BEGIN
  CREATE TYPE public.postop_booking_status AS ENUM (
    'requested','provisionally_confirmed','confirmed','admitted','cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.postop_cancellation_reason AS ENUM (
    'no_bed','patient_unfit','surgery_deferred','died_pre_op','other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2) Columns on postop_bookings
ALTER TABLE public.postop_bookings
  ADD COLUMN IF NOT EXISTS booking_status public.postop_booking_status NOT NULL DEFAULT 'requested',
  ADD COLUMN IF NOT EXISTS cancellation_reason public.postop_cancellation_reason,
  ADD COLUMN IF NOT EXISTS cancellation_notes text,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS preop_signed_off_at timestamptz,
  ADD COLUMN IF NOT EXISTS preop_signed_off_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS intensivist_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS intensivist_reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS converted_referral_id uuid REFERENCES public.referrals(id) ON DELETE SET NULL;

-- 3) Backfill lifecycle from arrived_at
UPDATE public.postop_bookings
   SET booking_status = 'admitted'
 WHERE arrived_at IS NOT NULL
   AND booking_status = 'requested';

-- 4) Planner index
CREATE INDEX IF NOT EXISTS postop_bookings_status_date_idx
  ON public.postop_bookings (proposed_surgery_date, booking_status);
CREATE INDEX IF NOT EXISTS postop_bookings_cancelled_at_idx
  ON public.postop_bookings (cancelled_at DESC) WHERE cancelled_at IS NOT NULL;

-- 5) Origin booking link on referrals
ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS origin_booking_id uuid REFERENCES public.postop_bookings(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS referrals_origin_booking_idx
  ON public.referrals (origin_booking_id) WHERE origin_booking_id IS NOT NULL;

-- 6) Transition validation trigger
CREATE OR REPLACE FUNCTION public.postop_bookings_validate_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  -- Cancellation requires a reason.
  IF NEW.booking_status = 'cancelled' THEN
    IF NEW.cancellation_reason IS NULL THEN
      RAISE EXCEPTION 'cancellation_reason is required when booking_status = cancelled'
        USING ERRCODE = '22023';
    END IF;
    IF NEW.cancelled_at IS NULL THEN
      NEW.cancelled_at := now();
    END IF;
  END IF;

  -- Confirming requires both sign-offs.
  IF NEW.booking_status = 'confirmed'
     AND (TG_OP = 'INSERT' OR OLD.booking_status IS DISTINCT FROM 'confirmed') THEN
    IF NEW.preop_signed_off_at IS NULL OR NEW.intensivist_reviewed_at IS NULL THEN
      RAISE EXCEPTION 'Both anaesthetic sign-off and intensivist review are required to confirm a booking'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Admitted auto-stamps arrived_at.
  IF NEW.booking_status = 'admitted' AND NEW.arrived_at IS NULL THEN
    NEW.arrived_at := now();
  END IF;

  -- Non-cancelled rows must not carry cancellation metadata.
  IF NEW.booking_status <> 'cancelled' THEN
    NEW.cancellation_reason := NULL;
    NEW.cancelled_at := NULL;
    NEW.cancelled_by := NULL;
    NEW.cancellation_notes := NULL;
  END IF;

  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS postop_bookings_validate_lifecycle_trg ON public.postop_bookings;
CREATE TRIGGER postop_bookings_validate_lifecycle_trg
BEFORE INSERT OR UPDATE ON public.postop_bookings
FOR EACH ROW EXECUTE FUNCTION public.postop_bookings_validate_lifecycle();
