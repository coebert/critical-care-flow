
-- Add encrypted columns for sensitive free-text fields and a hashed
-- lookup column for hospital_number. All app-layer encryption: the
-- key lives in the server environment, never in the database.

ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS past_medical_history_enc text,
  ADD COLUMN IF NOT EXISTS baseline_function_enc text,
  ADD COLUMN IF NOT EXISTS reason_for_referral_enc text,
  ADD COLUMN IF NOT EXISTS hospital_number_hash text;

CREATE INDEX IF NOT EXISTS referrals_hospital_number_hash_idx
  ON public.referrals (hospital_number_hash)
  WHERE deleted_at IS NULL;

ALTER TABLE public.referral_notes
  ADD COLUMN IF NOT EXISTS body_enc text;
