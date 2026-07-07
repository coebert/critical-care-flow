DROP POLICY "Note author inserts wrapped keys" ON public.referral_note_keys;

CREATE POLICY "Note author or admin inserts wrapped keys"
ON public.referral_note_keys
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.referral_notes n
    WHERE n.id = referral_note_keys.note_id
      AND n.author_id = auth.uid()
  )
  OR public.has_role(auth.uid(), 'admin'::app_role)
);