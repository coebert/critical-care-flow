
ALTER TABLE public.nurse_capacity_alert_state
  ADD COLUMN IF NOT EXISTS level3_last_alerted_at timestamptz,
  ADD COLUMN IF NOT EXISTS level2_last_alerted_at timestamptz,
  ADD COLUMN IF NOT EXISTS level1_last_alerted_at timestamptz;
