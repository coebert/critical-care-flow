ALTER TABLE public.referrals
  DROP COLUMN IF EXISTS past_medical_history,
  DROP COLUMN IF EXISTS baseline_function,
  DROP COLUMN IF EXISTS reason_for_referral,
  DROP COLUMN IF EXISTS hospital_number;

ALTER TABLE public.referral_notes
  DROP COLUMN IF EXISTS body;