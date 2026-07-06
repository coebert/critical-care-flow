ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

ALTER TABLE public.postop_bookings
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS referrals_is_test_idx
  ON public.referrals (is_test) WHERE is_test = false;

CREATE INDEX IF NOT EXISTS postop_bookings_is_test_idx
  ON public.postop_bookings (is_test) WHERE is_test = false;