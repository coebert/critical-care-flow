
-- Ensure UPDATE/DELETE realtime payloads carry the full row (needed for filter-based subscribers)
ALTER TABLE public.beds REPLICA IDENTITY FULL;
ALTER TABLE public.bed_occupancies REPLICA IDENTITY FULL;
ALTER TABLE public.bed_outliers REPLICA IDENTITY FULL;
ALTER TABLE public.bed_transfers_out REPLICA IDENTITY FULL;
ALTER TABLE public.patients REPLICA IDENTITY FULL;
ALTER TABLE public.investigations REPLICA IDENTITY FULL;

-- Add shared patient tables to the realtime publication (bed_* already added previously)
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.patients;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.investigations;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
