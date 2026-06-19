
ALTER TABLE public.referral_notes
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS edited_at timestamptz;

DROP TRIGGER IF EXISTS set_referral_notes_updated_at ON public.referral_notes;
CREATE TRIGGER set_referral_notes_updated_at
  BEFORE UPDATE ON public.referral_notes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP POLICY IF EXISTS "Notes deletable by admins" ON public.referral_notes;
CREATE POLICY "Notes deletable by author or admin"
  ON public.referral_notes FOR DELETE
  TO authenticated
  USING (auth.uid() = author_id OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Notes updatable by author or admin"
  ON public.referral_notes FOR UPDATE
  TO authenticated
  USING (auth.uid() = author_id OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_clinical_access(auth.uid()));
