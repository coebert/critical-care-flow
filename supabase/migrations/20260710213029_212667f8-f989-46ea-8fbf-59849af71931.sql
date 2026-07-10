
-- Enums
CREATE TYPE public.bridge_reconcile_job_status AS ENUM
  ('queued','running','complete','failed','cancelled');

CREATE TYPE public.bridge_reconcile_item_status AS ENUM
  ('pending','running','complete','error','locked','skipped');

-- Jobs
CREATE TABLE public.bridge_reconcile_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_ts timestamptz NOT NULL,
  to_ts timestamptz NOT NULL,
  dry_run boolean NOT NULL DEFAULT false,
  status public.bridge_reconcile_job_status NOT NULL DEFAULT 'queued',
  requested_by uuid,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX bridge_reconcile_jobs_status_created_idx
  ON public.bridge_reconcile_jobs (status, created_at);

GRANT SELECT ON public.bridge_reconcile_jobs TO authenticated;
GRANT ALL ON public.bridge_reconcile_jobs TO service_role;

ALTER TABLE public.bridge_reconcile_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins view reconcile jobs"
  ON public.bridge_reconcile_jobs
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

-- Job items (per bed resource)
CREATE TABLE public.bridge_reconcile_job_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.bridge_reconcile_jobs(id) ON DELETE CASCADE,
  resource text NOT NULL,
  status public.bridge_reconcile_item_status NOT NULL DEFAULT 'pending',
  pulled integer NOT NULL DEFAULT 0,
  pushed integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  pulled_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  pushed_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  locked_since timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, resource)
);
CREATE INDEX bridge_reconcile_job_items_job_idx
  ON public.bridge_reconcile_job_items (job_id);

GRANT SELECT ON public.bridge_reconcile_job_items TO authenticated;
GRANT ALL ON public.bridge_reconcile_job_items TO service_role;

ALTER TABLE public.bridge_reconcile_job_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins view reconcile job items"
  ON public.bridge_reconcile_job_items
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

-- Realtime: full row on UPDATE so the panel gets pulled/pushed/skipped deltas
ALTER TABLE public.bridge_reconcile_jobs REPLICA IDENTITY FULL;
ALTER TABLE public.bridge_reconcile_job_items REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.bridge_reconcile_jobs;
ALTER PUBLICATION supabase_realtime ADD TABLE public.bridge_reconcile_job_items;

-- Trigger: kick the worker immediately when a job is queued so the admin
-- doesn't wait for the 1-min pg_cron backstop.
CREATE OR REPLACE FUNCTION public.bridge_reconcile_jobs_kick_worker()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM net.http_post(
    url := 'https://project--a8eeeba1-1944-4344-93c0-4f9de4184412.lovable.app/api/public/hooks/bridge-reconcile-worker',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'apikey','eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpmeHZqaHBhY3Nva2lucGFjeGhpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4NjY5MTEsImV4cCI6MjA5NzQ0MjkxMX0.wQ6Rd49t6K86E5NbvoVrT3UTICgTK4PFYDsBqaTcUNA'
    ),
    body := jsonb_build_object('kick', NEW.id)
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block a job insert on the kick; pg_cron backstop will pick it up.
  RETURN NEW;
END;
$$;

CREATE TRIGGER bridge_reconcile_jobs_kick_worker_trg
AFTER INSERT ON public.bridge_reconcile_jobs
FOR EACH ROW
EXECUTE FUNCTION public.bridge_reconcile_jobs_kick_worker();
