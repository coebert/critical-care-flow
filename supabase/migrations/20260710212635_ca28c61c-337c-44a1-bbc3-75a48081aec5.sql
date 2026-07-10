
CREATE TABLE public.bridge_reconcile_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource text NOT NULL,
  from_ts timestamptz NOT NULL,
  to_ts timestamptz NOT NULL,
  locked_at timestamptz NOT NULL DEFAULT now(),
  locked_by uuid,
  UNIQUE (resource, from_ts, to_ts)
);

GRANT ALL ON public.bridge_reconcile_locks TO service_role;

ALTER TABLE public.bridge_reconcile_locks ENABLE ROW LEVEL SECURITY;

-- No direct client access; server-side (service_role) reconciliation only.
CREATE POLICY "Admins can view reconcile locks"
  ON public.bridge_reconcile_locks
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));
