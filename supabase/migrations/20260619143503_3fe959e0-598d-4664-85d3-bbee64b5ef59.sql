CREATE OR REPLACE FUNCTION public.prevent_unauthorized_soft_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;