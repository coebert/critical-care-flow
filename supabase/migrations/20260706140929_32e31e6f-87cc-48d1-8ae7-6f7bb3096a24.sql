-- Mirror the referrals UPDATE split for postop_bookings:
--   - Any clinical-access user may update a LIVE row (deleted_at IS NULL).
--   - Only the creator or an admin may toggle the deleted_at/deleted_by
--     fields (soft-delete or restore). This is additionally enforced by the
--     existing `postop_bookings_guard_soft_delete` trigger, which raises
--     42501 if a non-creator non-admin tries to change those columns.
DROP POLICY IF EXISTS "Bookings updatable by creator or admin" ON public.postop_bookings;

CREATE POLICY "Bookings live-row updates by clinical staff"
ON public.postop_bookings
FOR UPDATE
TO authenticated
USING (has_clinical_access(auth.uid()) AND deleted_at IS NULL)
WITH CHECK (has_clinical_access(auth.uid()));

CREATE POLICY "Bookings soft-delete or restore by creator or admin"
ON public.postop_bookings
FOR UPDATE
TO authenticated
USING (
  has_clinical_access(auth.uid())
  AND (auth.uid() = created_by OR has_role(auth.uid(), 'admin'::app_role))
)
WITH CHECK (
  has_clinical_access(auth.uid())
  AND (auth.uid() = created_by OR has_role(auth.uid(), 'admin'::app_role))
);