-- Allow Level 0 (fully wardable) and add a wardable flag on bed occupancies and outliers.

ALTER TABLE public.bed_occupancies DROP CONSTRAINT IF EXISTS bed_occupancies_level_check;
ALTER TABLE public.bed_occupancies ALTER COLUMN level DROP DEFAULT;
ALTER TABLE public.bed_occupancies ADD CONSTRAINT bed_occupancies_level_check CHECK (level >= 0 AND level <= 3);
ALTER TABLE public.bed_occupancies ALTER COLUMN level SET DEFAULT 3;

ALTER TABLE public.bed_occupancies
  ADD COLUMN IF NOT EXISTS wardable boolean NOT NULL DEFAULT false;

-- Keep outliers consistent (they also carry a level 1-3 today).
ALTER TABLE public.bed_outliers DROP CONSTRAINT IF EXISTS bed_outliers_level_check;
ALTER TABLE public.bed_outliers ADD CONSTRAINT bed_outliers_level_check CHECK (level IS NULL OR (level >= 0 AND level <= 3));