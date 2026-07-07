
CREATE TABLE public.nurse_capacity_alert_state (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id = true),
  shift_key TEXT,
  level3_available BOOLEAN,
  level2_available BOOLEAN,
  level1_available BOOLEAN,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.nurse_capacity_alert_state TO authenticated;
GRANT ALL ON public.nurse_capacity_alert_state TO service_role;

ALTER TABLE public.nurse_capacity_alert_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read capacity alert state"
  ON public.nurse_capacity_alert_state
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
