
CREATE TABLE public.referral_saved_views (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.referral_saved_views TO authenticated;
GRANT ALL ON public.referral_saved_views TO service_role;

ALTER TABLE public.referral_saved_views ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read their own saved views"
  ON public.referral_saved_views FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users create their own saved views"
  ON public.referral_saved_views FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users update their own saved views"
  ON public.referral_saved_views FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users delete their own saved views"
  ON public.referral_saved_views FOR DELETE TO authenticated
  USING (user_id = auth.uid());

CREATE TRIGGER referral_saved_views_set_updated_at
  BEFORE UPDATE ON public.referral_saved_views
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX referral_saved_views_user_updated_idx
  ON public.referral_saved_views (user_id, updated_at DESC);
