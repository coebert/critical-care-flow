-- Synthetic stand-in for the live referral tables that 0007 changes, for the
-- disposable check only. Grants, RLS policies, trigger functions and FK
-- delete actions are copied from the live catalog (read-only query,
-- 2026-11-16); columns are trimmed to the ones those objects use.
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

CREATE TYPE public.app_role AS ENUM ('admin', 'clinician');
CREATE TABLE public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL, UNIQUE (user_id, role));
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;


CREATE OR REPLACE FUNCTION public.has_clinical_access(_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role IN ('admin','clinician')) $$;
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
REVOKE ALL ON FUNCTION public.has_clinical_access(uuid), public.has_role(uuid, app_role) FROM PUBLIC;
CREATE POLICY "Roles readable by self or admin" ON public.user_roles FOR SELECT TO authenticated USING (((auth.uid() = user_id) OR has_role(auth.uid(), 'admin'::app_role)));
GRANT EXECUTE ON FUNCTION public.has_clinical_access(uuid), public.has_role(uuid, app_role) TO authenticated, service_role;

CREATE TABLE public.referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'pending',
  referral_received_at timestamptz NOT NULL DEFAULT now(),
  news2_score smallint, frailty_score smallint, weight_kg numeric, allergies text, infection_organism text,
  previous_referral_id uuid REFERENCES public.referrals(id) ON DELETE SET NULL,
  outcome text, outcome_recorded_at timestamptz,
  created_by uuid, updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz, deleted_by uuid
);
CREATE TABLE public.referral_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id uuid NOT NULL REFERENCES public.referrals(id) ON DELETE CASCADE,
  author_id uuid NOT NULL, body_enc text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), edited_at timestamptz
);
CREATE TABLE public.referral_note_keys (
  note_id uuid NOT NULL REFERENCES public.referral_notes(id) ON DELETE CASCADE,
  recipient_user_id uuid NOT NULL, wrapped_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (note_id, recipient_user_id)
);
CREATE TABLE public.referral_tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), referral_id uuid NOT NULL REFERENCES public.referrals(id) ON DELETE CASCADE, title text NOT NULL, created_by uuid NOT NULL);
CREATE TABLE public.referral_messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), referral_id uuid NOT NULL REFERENCES public.referrals(id) ON DELETE CASCADE, body text NOT NULL, sent_by uuid NOT NULL);
CREATE TABLE public.notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, referral_id uuid REFERENCES public.referrals(id) ON DELETE CASCADE, kind text NOT NULL, message text NOT NULL);
CREATE TABLE public.postop_bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), converted_referral_id uuid REFERENCES public.referrals(id) ON DELETE SET NULL);

-- Live grants (aclexplode on the live catalog).
GRANT ALL ON public.referrals, public.referral_notes, public.referral_note_keys, public.referral_tasks, public.referral_messages TO authenticated, service_role;
GRANT ALL ON public.notifications TO anon, authenticated, service_role;
GRANT ALL ON public.postop_bookings TO authenticated, service_role;

ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_note_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.postop_bookings ENABLE ROW LEVEL SECURITY;

-- Live policies, verbatim expressions.
CREATE POLICY "Referrals insertable by clinical staff" ON public.referrals FOR INSERT TO authenticated
  WITH CHECK ((has_clinical_access(auth.uid()) AND (auth.uid() = created_by)));
CREATE POLICY "Referrals deletable by creator or admin" ON public.referrals FOR DELETE TO authenticated
  USING (((auth.uid() = created_by) OR has_role(auth.uid(), 'admin'::app_role)));
CREATE POLICY "Referrals readable by clinical staff" ON public.referrals FOR SELECT TO authenticated
  USING ((has_clinical_access(auth.uid()) AND ((deleted_at IS NULL) OR (auth.uid() = created_by) OR has_role(auth.uid(), 'admin'::app_role))));
CREATE POLICY "Referrals live-row updates by clinical staff" ON public.referrals FOR UPDATE TO authenticated
  USING ((has_clinical_access(auth.uid()) AND (deleted_at IS NULL)))
  WITH CHECK ((has_clinical_access(auth.uid()) AND (deleted_at IS NULL) AND (deleted_by IS NULL)));
CREATE POLICY "Referrals soft-delete or restore by creator or admin" ON public.referrals FOR UPDATE TO authenticated
  USING ((has_clinical_access(auth.uid()) AND ((auth.uid() = created_by) OR has_role(auth.uid(), 'admin'::app_role))))
  WITH CHECK ((has_clinical_access(auth.uid()) AND ((auth.uid() = created_by) OR has_role(auth.uid(), 'admin'::app_role))));

CREATE POLICY "Notes insertable by author" ON public.referral_notes FOR INSERT TO authenticated
  WITH CHECK ((has_clinical_access(auth.uid()) AND (auth.uid() = author_id)));
CREATE POLICY "Notes deletable by author or admin" ON public.referral_notes FOR DELETE TO authenticated
  USING (((auth.uid() = author_id) OR has_role(auth.uid(), 'admin'::app_role)));
CREATE POLICY "Notes readable by clinical staff" ON public.referral_notes FOR SELECT TO authenticated
  USING (has_clinical_access(auth.uid()));
CREATE POLICY "Notes updatable by author or admin" ON public.referral_notes FOR UPDATE TO authenticated
  USING (((auth.uid() = author_id) OR has_role(auth.uid(), 'admin'::app_role))) WITH CHECK (has_clinical_access(auth.uid()));

CREATE POLICY "Note author or admin inserts wrapped keys" ON public.referral_note_keys FOR INSERT TO authenticated
  WITH CHECK (((EXISTS (SELECT 1 FROM referral_notes n WHERE ((n.id = referral_note_keys.note_id) AND (n.author_id = auth.uid())))) OR has_role(auth.uid(), 'admin'::app_role)));
CREATE POLICY "Note author or admin deletes wrapped keys" ON public.referral_note_keys FOR DELETE TO authenticated
  USING (((EXISTS (SELECT 1 FROM referral_notes n WHERE ((n.id = referral_note_keys.note_id) AND (n.author_id = auth.uid())))) OR has_role(auth.uid(), 'admin'::app_role)));
CREATE POLICY "Recipient or author reads wrapped key" ON public.referral_note_keys FOR SELECT TO authenticated
  USING (((recipient_user_id = auth.uid()) OR (EXISTS (SELECT 1 FROM referral_notes n WHERE ((n.id = referral_note_keys.note_id) AND (n.author_id = auth.uid())))) OR has_role(auth.uid(), 'admin'::app_role)));

CREATE POLICY "Admins can delete tasks" ON public.referral_tasks FOR DELETE TO authenticated USING (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Clinical staff can read tasks on live referrals" ON public.referral_tasks FOR SELECT TO authenticated
  USING ((has_clinical_access(auth.uid()) AND (EXISTS (SELECT 1 FROM referrals r WHERE ((r.id = referral_tasks.referral_id) AND (r.deleted_at IS NULL))))));
CREATE POLICY "Admins can delete referral messages" ON public.referral_messages FOR DELETE TO authenticated USING (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Clinical staff can read messages on live referrals" ON public.referral_messages FOR SELECT TO authenticated
  USING ((has_clinical_access(auth.uid()) AND (EXISTS (SELECT 1 FROM referrals r WHERE ((r.id = referral_messages.referral_id) AND (r.deleted_at IS NULL))))));

-- Live trigger functions, verbatim bodies.
CREATE OR REPLACE FUNCTION public.prevent_unauthorized_soft_delete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF (NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
     OR (NEW.deleted_by IS DISTINCT FROM OLD.deleted_by) THEN
    IF auth.uid() IS DISTINCT FROM OLD.created_by
       AND NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
      RAISE EXCEPTION 'Only the creator or an admin can soft-delete or restore this referral'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS
$function$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $function$;
CREATE OR REPLACE FUNCTION public.referrals_validate_clinical() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  IF NEW.news2_score IS NOT NULL AND (NEW.news2_score < 0 OR NEW.news2_score > 20) THEN
    RAISE EXCEPTION 'news2_score must be between 0 and 20' USING ERRCODE = '22023';
  END IF;
  IF NEW.previous_referral_id IS NOT NULL AND NEW.previous_referral_id = NEW.id THEN
    RAISE EXCEPTION 'previous_referral_id cannot reference the same referral' USING ERRCODE = '22023';
  END IF;
  IF NEW.outcome IS DISTINCT FROM COALESCE(OLD.outcome, NULL) AND NEW.outcome IS NOT NULL
     AND NEW.outcome_recorded_at IS NULL THEN
    NEW.outcome_recorded_at := now();
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.prevent_unauthorized_soft_delete(), public.set_updated_at() FROM PUBLIC;
CREATE TRIGGER referrals_guard_soft_delete BEFORE UPDATE ON public.referrals FOR EACH ROW EXECUTE FUNCTION prevent_unauthorized_soft_delete();
CREATE TRIGGER referrals_set_updated_at BEFORE UPDATE ON public.referrals FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_referrals_validate_clinical BEFORE INSERT OR UPDATE ON public.referrals FOR EACH ROW EXECUTE FUNCTION referrals_validate_clinical();
CREATE TRIGGER set_referral_notes_updated_at BEFORE UPDATE ON public.referral_notes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
