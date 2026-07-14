ALTER TABLE public.patient_wardable_status
  ADD COLUMN IF NOT EXISTS discharged_at timestamptz;

CREATE OR REPLACE FUNCTION public.set_patient_wardable_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'INSERT' then
    if coalesce(new.wardable, false) = true and new.wardable_at is null then
      new.wardable_at := now();
    end if;
  elsif tg_op = 'UPDATE' then
    if coalesce(new.wardable, false) is distinct from coalesce(old.wardable, false) then
      if coalesce(new.wardable, false) = true then
        -- Re-declaring wardable starts a fresh discharge window.
        new.wardable_at := coalesce(new.wardable_at, now());
        new.discharged_at := null;
      else
        new.wardable_at := null;
      end if;
    end if;
    new.updated_at := now();
  end if;
  return new;
end;
$function$;