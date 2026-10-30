DROP POLICY IF EXISTS "Any authenticated user can read public keys" ON public.user_public_keys;
CREATE POLICY "Own or clinical staff can read public keys"
ON public.user_public_keys FOR SELECT TO authenticated
USING (auth.uid() = user_id OR public.has_clinical_access(auth.uid()));