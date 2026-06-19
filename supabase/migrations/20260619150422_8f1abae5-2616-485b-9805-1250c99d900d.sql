-- Referrals: only admins can change deleted_at/deleted_by via direct client UPDATEs.
DROP POLICY IF EXISTS "Referrals updatable by clinical staff" ON public.referrals;
CREATE POLICY "Referrals updatable by clinical staff" ON public.referrals
  FOR UPDATE TO authenticated
  USING (public.has_clinical_access(auth.uid()))
  WITH CHECK (
    public.has_clinical_access(auth.uid())
    AND (
      (deleted_at IS NULL AND deleted_by IS NULL)
      OR public.has_role(auth.uid(), 'admin')
    )
  );

-- Notifications: owners may only toggle read_at; all other fields are immutable.
DROP POLICY IF EXISTS "Notifications updatable by owner" ON public.notifications;
CREATE POLICY "Notifications updatable by owner" ON public.notifications
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.notifications_protect_immutable_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.referral_id IS DISTINCT FROM OLD.referral_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.message IS DISTINCT FROM OLD.message
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Only read_at may be modified on a notification'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.notifications_protect_immutable_fields() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS notifications_protect_immutable_fields ON public.notifications;
CREATE TRIGGER notifications_protect_immutable_fields
  BEFORE UPDATE ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.notifications_protect_immutable_fields();