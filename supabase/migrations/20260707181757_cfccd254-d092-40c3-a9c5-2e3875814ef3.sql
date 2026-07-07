ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS needs_ward_review boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ward_review_timeframe text,
  ADD COLUMN IF NOT EXISTS for_ongoing_ccot_review boolean NOT NULL DEFAULT false;

-- Constrain the timeframe to a small controlled set. Set-membership is
-- immutable so a CHECK constraint is appropriate here.
ALTER TABLE public.referrals
  DROP CONSTRAINT IF EXISTS referrals_ward_review_timeframe_check;

ALTER TABLE public.referrals
  ADD CONSTRAINT referrals_ward_review_timeframe_check
  CHECK (
    ward_review_timeframe IS NULL
    OR ward_review_timeframe IN ('12h','24h','48h','72h','weekly','prn')
  );

-- Only allow a timeframe when at least one review flag is set; keeps the
-- three fields internally consistent.
ALTER TABLE public.referrals
  DROP CONSTRAINT IF EXISTS referrals_ward_review_timeframe_requires_flag;

ALTER TABLE public.referrals
  ADD CONSTRAINT referrals_ward_review_timeframe_requires_flag
  CHECK (
    ward_review_timeframe IS NULL
    OR needs_ward_review = true
    OR for_ongoing_ccot_review = true
  );

COMMENT ON COLUMN public.referrals.needs_ward_review IS
  'Patient needs ongoing review on the ward (flagged by critical care team).';
COMMENT ON COLUMN public.referrals.ward_review_timeframe IS
  'Suggested cadence for the next ward / CCOT review: 12h, 24h, 48h, 72h, weekly, prn.';
COMMENT ON COLUMN public.referrals.for_ongoing_ccot_review IS
  'Patient stays on the Critical Care Outreach Team ongoing review list.';