
CREATE OR REPLACE FUNCTION public.bed_transfers_out_stamp_authorship()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by IS NULL THEN NEW.created_by := auth.uid(); END IF;
    NEW.updated_by := COALESCE(NEW.updated_by, NEW.created_by);
    NEW.created_at := COALESCE(NEW.created_at, now());
    NEW.updated_at := now();
  ELSIF TG_OP = 'UPDATE' THEN
    -- Preserve original creator; never let clients rewrite it.
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
    NEW.updated_by := COALESCE(auth.uid(), NEW.updated_by, OLD.updated_by);
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bed_transfers_out_stamp_authorship ON public.bed_transfers_out;
CREATE TRIGGER bed_transfers_out_stamp_authorship
  BEFORE INSERT OR UPDATE ON public.bed_transfers_out
  FOR EACH ROW EXECUTE FUNCTION public.bed_transfers_out_stamp_authorship();
