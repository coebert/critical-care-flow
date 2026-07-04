
-- Post-op bookings: restrict UPDATE (edit + soft-delete + restore) to
-- the creator or an admin, so one clinician can't mutate another's booking.
DROP POLICY IF EXISTS "Clinicians can update post-op bookings" ON public.postop_bookings;
CREATE POLICY "Bookings updatable by creator or admin"
ON public.postop_bookings
FOR UPDATE
TO authenticated
USING (
  has_clinical_access(auth.uid())
  AND (auth.uid() = created_by OR public.has_role(auth.uid(), 'admin'::app_role))
)
WITH CHECK (
  has_clinical_access(auth.uid())
  AND (auth.uid() = created_by OR public.has_role(auth.uid(), 'admin'::app_role))
);

-- Referrals: keep collaborative editing on live rows, but disallow any
-- non-creator, non-admin from targeting a soft-deleted row (the restore
-- path). Combined with the existing WITH CHECK, this makes restore
-- authorization enforced by RLS itself, not only by the trigger.
DROP POLICY IF EXISTS "Referrals updatable by clinical staff" ON public.referrals;
CREATE POLICY "Referrals updatable by clinical staff"
ON public.referrals
FOR UPDATE
TO authenticated
USING (
  has_clinical_access(auth.uid())
  AND (
    deleted_at IS NULL
    OR auth.uid() = created_by
    OR public.has_role(auth.uid(), 'admin'::app_role)
  )
)
WITH CHECK (
  has_clinical_access(auth.uid())
  AND (
    (deleted_at IS NULL AND deleted_by IS NULL)
    OR auth.uid() = created_by
    OR public.has_role(auth.uid(), 'admin'::app_role)
  )
);
