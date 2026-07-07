
-- Communication (Point 6): tasks, message templates, referring-team message log

-- 1. referral_tasks -----------------------------------------------------------
CREATE TABLE public.referral_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id uuid NOT NULL REFERENCES public.referrals(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  details text CHECK (details IS NULL OR char_length(details) <= 2000),
  assigned_role public.app_role,
  due_at timestamptz,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  created_by uuid NOT NULL DEFAULT auth.uid(),
  completed_by uuid,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX referral_tasks_referral_status_idx ON public.referral_tasks (referral_id, status);
CREATE INDEX referral_tasks_status_due_idx ON public.referral_tasks (status, due_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.referral_tasks TO authenticated;
GRANT ALL ON public.referral_tasks TO service_role;
ALTER TABLE public.referral_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Clinical staff can read tasks on live referrals"
  ON public.referral_tasks FOR SELECT TO authenticated
  USING (
    public.has_clinical_access(auth.uid())
    AND EXISTS (SELECT 1 FROM public.referrals r WHERE r.id = referral_id AND r.deleted_at IS NULL)
  );

CREATE POLICY "Clinical staff can create tasks on live referrals"
  ON public.referral_tasks FOR INSERT TO authenticated
  WITH CHECK (
    public.has_clinical_access(auth.uid())
    AND created_by = auth.uid()
    AND EXISTS (SELECT 1 FROM public.referrals r WHERE r.id = referral_id AND r.deleted_at IS NULL)
  );

CREATE POLICY "Clinical staff can update tasks on live referrals"
  ON public.referral_tasks FOR UPDATE TO authenticated
  USING (
    public.has_clinical_access(auth.uid())
    AND EXISTS (SELECT 1 FROM public.referrals r WHERE r.id = referral_id AND r.deleted_at IS NULL)
  );

CREATE POLICY "Admins can delete tasks"
  ON public.referral_tasks FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE TRIGGER referral_tasks_updated_at
  BEFORE UPDATE ON public.referral_tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2. message_templates --------------------------------------------------------
CREATE TABLE public.message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  category text NOT NULL CHECK (category IN ('decline','advice','plan','handover')),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_templates_category_active_idx ON public.message_templates (category, active);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.message_templates TO authenticated;
GRANT ALL ON public.message_templates TO service_role;
ALTER TABLE public.message_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read active templates"
  ON public.message_templates FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins manage templates (insert)"
  ON public.message_templates FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));
CREATE POLICY "Admins manage templates (update)"
  ON public.message_templates FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));
CREATE POLICY "Admins manage templates (delete)"
  ON public.message_templates FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE TRIGGER message_templates_updated_at
  BEFORE UPDATE ON public.message_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Seed default snippets
INSERT INTO public.message_templates (title, category, body) VALUES
  ('NIV trial on ward','advice','Suggest ward-based NIV trial with FiO2 titration. Please review in 2 h; if FiO2 >0.4 or RR >30, re-refer for ICU review.'),
  ('Ward-based ceiling of care','decline','Following discussion with the ICU consultant on call, this patient is felt to be for ward-based care with a ceiling of full ward-based treatment including antibiotics, fluids and non-invasive support as appropriate. Please complete a ReSPECT form.'),
  ('For CPAP not intubation','plan','Agreed plan: for a trial of CPAP on HDU. Ceiling of care is non-invasive ventilation; not for intubation. To be discussed with family.'),
  ('Not for escalation','decline','After MDT discussion the patient is not for escalation to critical care. Please continue best supportive ward-based care and involve the palliative care team.'),
  ('Come and review','advice','Registrar will attend to review the patient within the next 30 min. Please have the latest ABG, obs chart and imaging available at the bedside.'),
  ('Handover on acceptance','handover','Accepted for ICU admission. Bed being prepared. Please ensure IV access x2, up-to-date bloods including group and save, and continue current management until arrival.');

-- 3. referral_messages --------------------------------------------------------
CREATE TABLE public.referral_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id uuid NOT NULL REFERENCES public.referrals(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('phone','bleep','email','secure_msg','in_person')),
  direction text NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound','inbound')),
  recipient text CHECK (recipient IS NULL OR char_length(recipient) <= 200),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  template_id uuid REFERENCES public.message_templates(id) ON DELETE SET NULL,
  sent_by uuid NOT NULL DEFAULT auth.uid(),
  sent_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX referral_messages_referral_sent_idx ON public.referral_messages (referral_id, sent_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.referral_messages TO authenticated;
GRANT ALL ON public.referral_messages TO service_role;
ALTER TABLE public.referral_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Clinical staff can read messages on live referrals"
  ON public.referral_messages FOR SELECT TO authenticated
  USING (
    public.has_clinical_access(auth.uid())
    AND EXISTS (SELECT 1 FROM public.referrals r WHERE r.id = referral_id AND r.deleted_at IS NULL)
  );

CREATE POLICY "Clinical staff can log messages on live referrals"
  ON public.referral_messages FOR INSERT TO authenticated
  WITH CHECK (
    public.has_clinical_access(auth.uid())
    AND sent_by = auth.uid()
    AND EXISTS (SELECT 1 FROM public.referrals r WHERE r.id = referral_id AND r.deleted_at IS NULL)
  );

CREATE POLICY "Admins can delete referral messages"
  ON public.referral_messages FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));
