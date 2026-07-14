
-- 1. Local mirror: add wardable_at column + auto-timestamp trigger.
alter table public.bed_occupancies
  add column if not exists wardable_at timestamptz;

update public.bed_occupancies
  set wardable_at = coalesce(updated_at, admitted_at)
  where wardable = true and wardable_at is null;

create or replace function public.set_bed_occupancy_wardable_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if coalesce(new.wardable, false) = true and new.wardable_at is null then
      new.wardable_at := now();
    end if;
  elsif tg_op = 'UPDATE' then
    if coalesce(new.wardable, false) is distinct from coalesce(old.wardable, false) then
      if coalesce(new.wardable, false) = true then
        new.wardable_at := coalesce(new.wardable_at, now());
      else
        new.wardable_at := null;
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists set_bed_occupancy_wardable_at on public.bed_occupancies;
create trigger set_bed_occupancy_wardable_at
before insert or update on public.bed_occupancies
for each row execute function public.set_bed_occupancy_wardable_at();

-- 2. Per-partner-patient wardable status table (bed board reads from partner,
-- so this is the local source of truth for wardable state until the partner
-- app persists it too).
create table if not exists public.patient_wardable_status (
  partner_patient_id text primary key,
  wardable boolean not null default false,
  wardable_at timestamptz,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

grant select, insert, update on public.patient_wardable_status to authenticated;
grant all on public.patient_wardable_status to service_role;

alter table public.patient_wardable_status enable row level security;

create policy "Clinicians can view wardable status"
  on public.patient_wardable_status
  for select
  to authenticated
  using (public.has_clinical_access(auth.uid()));

create policy "Clinicians can upsert wardable status"
  on public.patient_wardable_status
  for insert
  to authenticated
  with check (public.has_clinical_access(auth.uid()));

create policy "Clinicians can update wardable status"
  on public.patient_wardable_status
  for update
  to authenticated
  using (public.has_clinical_access(auth.uid()))
  with check (public.has_clinical_access(auth.uid()));

create or replace function public.set_patient_wardable_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if coalesce(new.wardable, false) = true and new.wardable_at is null then
      new.wardable_at := now();
    end if;
  elsif tg_op = 'UPDATE' then
    if coalesce(new.wardable, false) is distinct from coalesce(old.wardable, false) then
      if coalesce(new.wardable, false) = true then
        new.wardable_at := coalesce(new.wardable_at, now());
      else
        new.wardable_at := null;
      end if;
    end if;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists set_patient_wardable_at on public.patient_wardable_status;
create trigger set_patient_wardable_at
before insert or update on public.patient_wardable_status
for each row execute function public.set_patient_wardable_at();
