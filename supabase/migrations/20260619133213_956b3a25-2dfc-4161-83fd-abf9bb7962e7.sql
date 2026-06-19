
-- ============ ENUMS ============
CREATE TYPE public.app_role AS ENUM ('admin', 'clinician');
CREATE TYPE public.referral_status AS ENUM ('pending', 'declined', 'admitted');
CREATE TYPE public.patient_sex AS ENUM ('male', 'female', 'other', 'unknown');
CREATE TYPE public.audit_action AS ENUM ('view', 'create', 'update', 'delete');

-- ============ PROFILES ============
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT,
  job_title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Profiles readable by authenticated" ON public.profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users update own profile" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- ============ USER ROLES ============
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Roles readable by authenticated" ON public.user_roles FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;

-- ============ AUTO-CREATE PROFILE + DEFAULT ROLE ON SIGNUP ============
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  user_count INT;
BEGIN
  INSERT INTO public.profiles (id, full_name, job_title)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    NEW.raw_user_meta_data->>'job_title'
  );

  SELECT count(*) INTO user_count FROM auth.users;
  IF user_count = 1 THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'admin');
  ELSE
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'clinician');
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============ REFERRALS ============
CREATE TABLE public.referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Patient
  age INT,
  sex public.patient_sex,
  hospital_number TEXT,
  current_ward TEXT,
  current_bed TEXT,
  past_medical_history TEXT,
  baseline_function TEXT,
  dnacpr_respect BOOLEAN NOT NULL DEFAULT false,
  referring_specialty TEXT,
  reason_for_referral TEXT,
  -- Timestamps (ICNARC)
  referral_received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  first_seen_at TIMESTAMPTZ,
  decision_at TIMESTAMPTZ,
  arrived_on_unit_at TIMESTAMPTZ,
  -- Outcome
  status public.referral_status NOT NULL DEFAULT 'pending',
  decline_reason TEXT,
  -- Meta
  created_by UUID REFERENCES auth.users(id),
  updated_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.referrals TO authenticated;
GRANT ALL ON public.referrals TO service_role;
ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Referrals readable by authenticated" ON public.referrals FOR SELECT TO authenticated USING (true);
CREATE POLICY "Referrals insertable by authenticated" ON public.referrals FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Referrals updatable by authenticated" ON public.referrals FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Referrals deletable by admins" ON public.referrals FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'admin'));

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER referrals_set_updated_at BEFORE UPDATE ON public.referrals
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER profiles_set_updated_at BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ REFERRAL NOTES ============
CREATE TABLE public.referral_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id UUID NOT NULL REFERENCES public.referrals(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES auth.users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.referral_notes TO authenticated;
GRANT ALL ON public.referral_notes TO service_role;
ALTER TABLE public.referral_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Notes readable by authenticated" ON public.referral_notes FOR SELECT TO authenticated USING (true);
CREATE POLICY "Notes insertable by author" ON public.referral_notes FOR INSERT TO authenticated WITH CHECK (auth.uid() = author_id);
CREATE POLICY "Notes deletable by admins" ON public.referral_notes FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- ============ AUDIT LOG ============
CREATE TABLE public.audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id),
  action public.audit_action NOT NULL,
  entity TEXT NOT NULL,
  entity_id UUID,
  diff JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.audit_log TO authenticated;
GRANT ALL ON public.audit_log TO service_role;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Audit insertable by authenticated" ON public.audit_log FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Audit readable by admins" ON public.audit_log FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- ============ NOTIFICATIONS ============
CREATE TABLE public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  referral_id UUID REFERENCES public.referrals(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Notifications readable by owner" ON public.notifications FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Notifications insertable by authenticated" ON public.notifications FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Notifications updatable by owner" ON public.notifications FOR UPDATE TO authenticated USING (auth.uid() = user_id);

-- ============ REALTIME ============
ALTER PUBLICATION supabase_realtime ADD TABLE public.referrals;
ALTER PUBLICATION supabase_realtime ADD TABLE public.referral_notes;
ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;

-- ============ INDEXES ============
CREATE INDEX referrals_status_idx ON public.referrals(status);
CREATE INDEX referrals_received_idx ON public.referrals(referral_received_at DESC);
CREATE INDEX referral_notes_ref_idx ON public.referral_notes(referral_id, created_at DESC);
CREATE INDEX notifications_user_idx ON public.notifications(user_id, created_at DESC);
CREATE INDEX audit_entity_idx ON public.audit_log(entity, entity_id, created_at DESC);
