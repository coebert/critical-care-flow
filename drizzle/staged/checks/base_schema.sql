-- Minimal stand-in for the live schema that 0003 builds on (synthetic, for
-- the disposable check only). Mirrors roles, auth.uid(), has_clinical_access,
-- patient_wardable_status columns/RLS/grants and its existing trigger.
DO $$ BEGIN
  CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role text NOT NULL);
CREATE OR REPLACE FUNCTION public.has_clinical_access(_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role IN ('admin','clinician')) $$;
CREATE TABLE public.patient_wardable_status (
  partner_patient_id text PRIMARY KEY,
  wardable boolean NOT NULL DEFAULT false,
  wardable_at timestamptz,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  discharged_at timestamptz,
  desired_revision bigint NOT NULL DEFAULT 0,
  partner_sync_status text CHECK (partner_sync_status IN ('pending','synced','failed','not_configured','conflict','not_shared')),
  partner_sync_checked_at timestamptz,
  partner_synced_revision bigint
);
GRANT SELECT, INSERT, UPDATE ON public.patient_wardable_status TO authenticated;
GRANT ALL ON public.patient_wardable_status TO service_role;
ALTER TABLE public.patient_wardable_status ENABLE ROW LEVEL SECURITY;
CREATE POLICY v ON public.patient_wardable_status FOR SELECT TO authenticated USING (public.has_clinical_access(auth.uid()));
CREATE POLICY i ON public.patient_wardable_status FOR INSERT TO authenticated WITH CHECK (public.has_clinical_access(auth.uid()));
CREATE POLICY u ON public.patient_wardable_status FOR UPDATE TO authenticated USING (public.has_clinical_access(auth.uid())) WITH CHECK (public.has_clinical_access(auth.uid()));
CREATE OR REPLACE FUNCTION public.set_patient_wardable_at() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
begin
  if tg_op = 'INSERT' then
    if coalesce(new.wardable, false) = true and new.wardable_at is null then new.wardable_at := now(); end if;
  elsif tg_op = 'UPDATE' then
    if coalesce(new.wardable, false) is distinct from coalesce(old.wardable, false) then
      if coalesce(new.wardable, false) = true then new.wardable_at := coalesce(new.wardable_at, now()); new.discharged_at := null;
      else new.wardable_at := null; end if;
    end if;
    new.updated_at := now();
  end if;
  return new;
end; $f$;
CREATE TRIGGER set_patient_wardable_at BEFORE INSERT OR UPDATE ON public.patient_wardable_status
  FOR EACH ROW EXECUTE FUNCTION public.set_patient_wardable_at();
