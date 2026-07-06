-- Replace the referrals SELECT policy so that soft-deleted referrals are only
-- readable by their creator or by an admin. Previously any clinical-access
-- user could read deleted rows via the Data API, which is a data-exposure
-- risk (the app UI filters them but a direct query would not).
DROP POLICY IF EXISTS "Referrals readable by clinical staff" ON public.referrals;

CREATE POLICY "Referrals readable by clinical staff"
ON public.referrals
FOR SELECT
TO authenticated
USING (
  has_clinical_access(auth.uid())
  AND (
    deleted_at IS NULL
    OR auth.uid() = created_by
    OR has_role(auth.uid(), 'admin'::app_role)
  )
);