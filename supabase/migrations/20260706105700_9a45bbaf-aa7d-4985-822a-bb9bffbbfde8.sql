-- Post-op bookings: broaden SELECT so a soft-deleted row is still visible
-- to its creator and to admins. Without this, setting deleted_at during
-- soft-delete fails the RETURNING visibility check on the same UPDATE and
-- surfaces as "new row violates row-level security policy". Clinicians who
-- did not create the booking still don't see deleted rows.
DROP POLICY IF EXISTS "Clinicians can view post-op bookings" ON public.postop_bookings;
CREATE POLICY "Clinicians can view post-op bookings"
ON public.postop_bookings
FOR SELECT
TO authenticated
USING (
  has_clinical_access(auth.uid())
  AND (
    deleted_at IS NULL
    OR auth.uid() = created_by
    OR public.has_role(auth.uid(), 'admin'::app_role)
  )
);