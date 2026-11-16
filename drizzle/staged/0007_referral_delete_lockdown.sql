-- 0007 — Referral hard-delete lockdown + clinical access for note deletion.
-- STAGED: apply only at the coordinated release, after 0003–0006, in one
-- transaction. Forward-only; no data is changed.
--
-- Why (verified in drizzle/staged/checks/0007_check.sh against copies of
-- the live grants/policies/triggers):
--   * `authenticated` holds DELETE (and TRUNCATE) on public.referrals and the
--     DELETE policy only asks "creator or admin". An active creator or admin
--     can hard-delete through the Data API, skipping the soft-delete tombstone
--     the Hub's `?sync=1` import relies on and cascading away notes, tasks,
--     messages and notifications. With an unfiltered DELETE (no WHERE, so the
--     SELECT policy is not consulted) a creator whose clinical access was
--     revoked still deletes their own referrals and notes.
--   * The native app never hard-deletes referrals (deleteReferral and
--     restoreReferral are soft-delete/restore UPDATEs).
--
-- After this migration:
--   * Client roles cannot DELETE or TRUNCATE referrals at all (grant revoked,
--     policy dropped, and a trigger refuses even if a grant reappears).
--     Soft-delete/restore by creator/admin with clinical access is unchanged.
--     service_role (operator/retention tooling) may still hard-delete.
--   * Deleting a note or a note's wrapped keys requires CURRENT clinical
--     access as well as author-or-admin. Cascades from a permitted note
--     delete still remove its keys (FK actions run as the table owner).

-- Preflight: refuse if the live policies drifted from what was reviewed.
DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
                 WHERE c.oid = 'public.referrals'::regclass AND p.polcmd = 'd'
                   AND p.polname = 'Referrals deletable by creator or admin') THEN
    RAISE EXCEPTION '0007 preflight: referrals DELETE policy not found as reviewed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = 'public.referral_notes'::regclass
                   AND p.polcmd = 'd' AND p.polname = 'Notes deletable by author or admin') THEN
    RAISE EXCEPTION '0007 preflight: referral_notes DELETE policy not found as reviewed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = 'public.referral_note_keys'::regclass
                   AND p.polcmd = 'd' AND p.polname = 'Note author or admin deletes wrapped keys') THEN
    RAISE EXCEPTION '0007 preflight: referral_note_keys DELETE policy not found as reviewed';
  END IF;
END
$pre$;

-- 1. Referrals: no client hard delete or truncate.
DROP POLICY "Referrals deletable by creator or admin" ON public.referrals;
REVOKE DELETE, TRUNCATE ON public.referrals FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.referrals_refuse_client_hard_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  -- SECURITY INVOKER on purpose: current_user is the role running the
  -- statement. Only client roles are refused; FK cascades never target
  -- referrals, and operator roles keep their (audited, out-of-band) purge.
  IF current_user IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'Referrals cannot be hard-deleted; use the soft delete (deleted_at) instead'
      USING ERRCODE = '42501';
  END IF;
  IF TG_LEVEL = 'ROW' THEN RETURN OLD; END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.referrals_refuse_client_hard_delete() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER referrals_refuse_client_hard_delete
  BEFORE DELETE ON public.referrals
  FOR EACH ROW EXECUTE FUNCTION public.referrals_refuse_client_hard_delete();
CREATE TRIGGER referrals_refuse_client_truncate
  BEFORE TRUNCATE ON public.referrals
  FOR EACH STATEMENT EXECUTE FUNCTION public.referrals_refuse_client_hard_delete();

-- 2. Notes and their wrapped keys: deletion needs current clinical access.
ALTER POLICY "Notes deletable by author or admin" ON public.referral_notes
  USING (public.has_clinical_access(auth.uid())
         AND ((auth.uid() = author_id) OR public.has_role(auth.uid(), 'admin'::public.app_role)));
ALTER POLICY "Note author or admin deletes wrapped keys" ON public.referral_note_keys
  USING (public.has_clinical_access(auth.uid())
         AND ((EXISTS (SELECT 1 FROM public.referral_notes n
                       WHERE n.id = referral_note_keys.note_id AND n.author_id = auth.uid()))
              OR public.has_role(auth.uid(), 'admin'::public.app_role)));
REVOKE TRUNCATE ON public.referral_notes, public.referral_note_keys FROM PUBLIC, anon, authenticated;
