
-- New enums
DO $$ BEGIN
  CREATE TYPE public.ceiling_of_care AS ENUM (
    'full_escalation', 'no_cpr', 'ward_based', 'symptom_control', 'not_documented'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.referral_reason_category AS ENUM (
    'respiratory_failure', 'sepsis', 'shock', 'post_op',
    'neurology', 'trauma', 'gi_bleed', 'metabolic', 'overdose', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.infection_status AS ENUM ('none', 'suspected', 'confirmed', 'unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.resus_status AS ENUM ('for_cpr', 'dnacpr', 'not_documented');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.referral_outcome AS ENUM (
    'admit_for_admission', 'review_on_ward', 'advice_given', 'declined'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- New columns on referrals (all nullable / with safe defaults)
ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS news2_score smallint,
  ADD COLUMN IF NOT EXISTS news2_recorded_at timestamptz,
  ADD COLUMN IF NOT EXISTS ceiling_of_care public.ceiling_of_care,
  ADD COLUMN IF NOT EXISTS reason_category public.referral_reason_category,
  ADD COLUMN IF NOT EXISTS frailty_score smallint,
  ADD COLUMN IF NOT EXISTS anticipated_interventions text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS infection_status public.infection_status,
  ADD COLUMN IF NOT EXISTS infection_organism text,
  ADD COLUMN IF NOT EXISTS weight_kg numeric(5,1),
  ADD COLUMN IF NOT EXISTS allergies text,
  ADD COLUMN IF NOT EXISTS resus_status public.resus_status,
  ADD COLUMN IF NOT EXISTS previous_referral_id uuid REFERENCES public.referrals(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS outcome public.referral_outcome,
  ADD COLUMN IF NOT EXISTS outcome_recorded_at timestamptz;

-- Validation triggers (CHECK constraints on referrals get hairy with historical data)
CREATE OR REPLACE FUNCTION public.referrals_validate_clinical()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.news2_score IS NOT NULL AND (NEW.news2_score < 0 OR NEW.news2_score > 20) THEN
    RAISE EXCEPTION 'news2_score must be between 0 and 20' USING ERRCODE = '22023';
  END IF;
  IF NEW.frailty_score IS NOT NULL AND (NEW.frailty_score < 1 OR NEW.frailty_score > 9) THEN
    RAISE EXCEPTION 'frailty_score must be between 1 and 9 (Rockwell CFS)' USING ERRCODE = '22023';
  END IF;
  IF NEW.weight_kg IS NOT NULL AND (NEW.weight_kg <= 0 OR NEW.weight_kg > 400) THEN
    RAISE EXCEPTION 'weight_kg must be between 0 and 400' USING ERRCODE = '22023';
  END IF;
  IF NEW.allergies IS NOT NULL AND char_length(NEW.allergies) > 1000 THEN
    RAISE EXCEPTION 'allergies must be at most 1000 characters' USING ERRCODE = '22023';
  END IF;
  IF NEW.infection_organism IS NOT NULL AND char_length(NEW.infection_organism) > 200 THEN
    RAISE EXCEPTION 'infection_organism must be at most 200 characters' USING ERRCODE = '22023';
  END IF;
  -- Prevent a referral linking to itself
  IF NEW.previous_referral_id IS NOT NULL AND NEW.previous_referral_id = NEW.id THEN
    RAISE EXCEPTION 'previous_referral_id cannot reference the same referral' USING ERRCODE = '22023';
  END IF;
  -- Auto-stamp outcome_recorded_at when outcome is first set / changed
  IF NEW.outcome IS DISTINCT FROM COALESCE(OLD.outcome, NULL) AND NEW.outcome IS NOT NULL
     AND NEW.outcome_recorded_at IS NULL THEN
    NEW.outcome_recorded_at := now();
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_referrals_validate_clinical ON public.referrals;
CREATE TRIGGER trg_referrals_validate_clinical
  BEFORE INSERT OR UPDATE ON public.referrals
  FOR EACH ROW EXECUTE FUNCTION public.referrals_validate_clinical();

-- Backfill outcome from legacy status so historical rows have a decision recorded.
UPDATE public.referrals
   SET outcome = CASE
        WHEN status IN ('accepted', 'admitted') THEN 'admit_for_admission'::public.referral_outcome
        WHEN status = 'declined' THEN 'declined'::public.referral_outcome
        ELSE NULL
      END,
       outcome_recorded_at = COALESCE(decision_at, updated_at)
 WHERE outcome IS NULL
   AND status IN ('accepted', 'admitted', 'declined');

-- Indexes to keep re-referral lookups and outcome filters fast.
CREATE INDEX IF NOT EXISTS idx_referrals_previous ON public.referrals(previous_referral_id)
  WHERE previous_referral_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_referrals_outcome ON public.referrals(outcome)
  WHERE outcome IS NOT NULL;
