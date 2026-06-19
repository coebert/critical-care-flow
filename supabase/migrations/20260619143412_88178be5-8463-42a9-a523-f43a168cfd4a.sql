CREATE OR REPLACE FUNCTION public.prevent_unauthorized_soft_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
     OR (NEW.deleted_by IS DISTINCT FROM OLD.deleted_by) THEN
    IF NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
      RAISE EXCEPTION 'Only admins can soft-delete or restore referrals'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS referrals_guard_soft_delete ON public.referrals;
CREATE TRIGGER referrals_guard_soft_delete
BEFORE UPDATE ON public.referrals
FOR EACH ROW
EXECUTE FUNCTION public.prevent_unauthorized_soft_delete();