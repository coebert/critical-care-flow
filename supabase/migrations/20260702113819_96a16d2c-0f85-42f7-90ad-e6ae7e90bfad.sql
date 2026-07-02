
CREATE OR REPLACE FUNCTION public.postop_bookings_guard_soft_delete()
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
      RAISE EXCEPTION 'Only the creator or an admin can soft-delete or restore this booking'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS postop_bookings_guard_soft_delete_trg ON public.postop_bookings;
CREATE TRIGGER postop_bookings_guard_soft_delete_trg
BEFORE UPDATE ON public.postop_bookings
FOR EACH ROW EXECUTE FUNCTION public.postop_bookings_guard_soft_delete();
