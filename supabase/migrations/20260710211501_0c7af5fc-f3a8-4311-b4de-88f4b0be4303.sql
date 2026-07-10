-- Audit log for every bridge sync attempt (per resource per run).
-- Populated by /api/public/bridge/sync and /api/public/bridge/retry-failed.
-- Admin-only readable via has_role.

CREATE TABLE public.bridge_sync_attempts (
  id BIGSERIAL PRIMARY KEY,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL CHECK (source IN ('sync','retry','manual')),
  resource TEXT NOT NULL,
  ok BOOLEAN NOT NULL,
  pulled INTEGER NOT NULL DEFAULT 0,
  pushed INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  error TEXT
);

CREATE INDEX bridge_sync_attempts_attempted_at_idx
  ON public.bridge_sync_attempts (attempted_at DESC);
CREATE INDEX bridge_sync_attempts_resource_idx
  ON public.bridge_sync_attempts (resource, attempted_at DESC);

-- Auto-prune rows older than 30 days so the table stays bounded.
CREATE OR REPLACE FUNCTION public.bridge_sync_attempts_prune()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only prune occasionally to avoid burning CPU on every insert.
  IF random() < 0.01 THEN
    DELETE FROM public.bridge_sync_attempts
      WHERE attempted_at < now() - INTERVAL '30 days';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER bridge_sync_attempts_prune_trg
  AFTER INSERT ON public.bridge_sync_attempts
  FOR EACH ROW EXECUTE FUNCTION public.bridge_sync_attempts_prune();

GRANT SELECT ON public.bridge_sync_attempts TO authenticated;
GRANT ALL ON public.bridge_sync_attempts TO service_role;

ALTER TABLE public.bridge_sync_attempts ENABLE ROW LEVEL SECURITY;

-- Admins only; nobody else can read or write from the client.
CREATE POLICY "Admins can read bridge sync attempts"
  ON public.bridge_sync_attempts FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));