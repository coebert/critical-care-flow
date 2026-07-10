-- microbiology
CREATE TABLE public.microbiology (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  organism TEXT NOT NULL,
  sample_type TEXT,
  sensitivities JSONB NOT NULL DEFAULT '{}'::jsonb,
  sampled_at TIMESTAMPTZ,
  reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_microbiology_patient ON public.microbiology(patient_id);
CREATE INDEX idx_microbiology_updated_at ON public.microbiology(updated_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.microbiology TO authenticated;
GRANT ALL ON public.microbiology TO service_role;

ALTER TABLE public.microbiology ENABLE ROW LEVEL SECURITY;

CREATE POLICY "clinical staff read microbiology"
  ON public.microbiology FOR SELECT TO authenticated
  USING (public.has_clinical_access(auth.uid()));

CREATE POLICY "clinical staff insert microbiology"
  ON public.microbiology FOR INSERT TO authenticated
  WITH CHECK (public.has_clinical_access(auth.uid()));

CREATE POLICY "clinical staff update microbiology"
  ON public.microbiology FOR UPDATE TO authenticated
  USING (public.has_clinical_access(auth.uid()))
  WITH CHECK (public.has_clinical_access(auth.uid()));

CREATE POLICY "admins delete microbiology"
  ON public.microbiology FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER trg_microbiology_updated_at
  BEFORE UPDATE ON public.microbiology
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- bridge_sync_state (machine bookkeeping, service_role only)
CREATE TABLE public.bridge_sync_state (
  resource TEXT PRIMARY KEY,
  last_pulled_at TIMESTAMPTZ,
  last_pushed_at TIMESTAMPTZ,
  last_error TEXT,
  last_error_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT ALL ON public.bridge_sync_state TO service_role;

ALTER TABLE public.bridge_sync_state ENABLE ROW LEVEL SECURITY;
-- No policies for anon/authenticated: only service_role (which bypasses RLS)
-- may read or write this table.

CREATE TRIGGER trg_bridge_sync_state_updated_at
  BEFORE UPDATE ON public.bridge_sync_state
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();