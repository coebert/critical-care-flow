
DROP POLICY IF EXISTS "Bookings live-row updates by clinical staff" ON public.postop_bookings;
CREATE POLICY "Bookings live-row updates by clinical staff"
ON public.postop_bookings
FOR UPDATE
USING (has_clinical_access(auth.uid()) AND deleted_at IS NULL)
WITH CHECK (
  has_clinical_access(auth.uid())
  AND deleted_at IS NULL
  AND deleted_by IS NULL
);

CREATE POLICY "Users can insert own profile"
ON public.profiles
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = id);
