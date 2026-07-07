ALTER TABLE public.nurse_capacity_alert_state
  ADD COLUMN IF NOT EXISTS level3_slots integer,
  ADD COLUMN IF NOT EXISTS level2_slots integer,
  ADD COLUMN IF NOT EXISTS level1_slots integer,
  ADD COLUMN IF NOT EXISTS spare integer;