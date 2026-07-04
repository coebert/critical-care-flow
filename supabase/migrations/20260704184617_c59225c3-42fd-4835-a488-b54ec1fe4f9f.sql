
CREATE TABLE public.icnarc_targets (
  id boolean PRIMARY KEY DEFAULT true,
  time_to_seen_target_min integer NOT NULL DEFAULT 30 CHECK (time_to_seen_target_min > 0 AND time_to_seen_target_min <= 100000),
  decision_to_arrival_target_min integer NOT NULL DEFAULT 240 CHECK (decision_to_arrival_target_min > 0 AND decision_to_arrival_target_min <= 100000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT icnarc_targets_singleton CHECK (id = true)
);

GRANT SELECT ON public.icnarc_targets TO authenticated;
GRANT UPDATE ON public.icnarc_targets TO authenticated;
GRANT ALL ON public.icnarc_targets TO service_role;

ALTER TABLE public.icnarc_targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Clinicians can read ICNARC targets"
  ON public.icnarc_targets FOR SELECT
  TO authenticated
  USING (public.has_clinical_access(auth.uid()));

CREATE POLICY "Admins can update ICNARC targets"
  ON public.icnarc_targets FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER icnarc_targets_set_updated_at
  BEFORE UPDATE ON public.icnarc_targets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.icnarc_targets (id) VALUES (true);
