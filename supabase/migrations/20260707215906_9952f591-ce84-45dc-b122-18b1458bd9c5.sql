DROP POLICY IF EXISTS "Authenticated users can read active templates" ON public.message_templates;

CREATE POLICY "Clinical users can read active templates"
ON public.message_templates
FOR SELECT
TO authenticated
USING (public.has_clinical_access(auth.uid()) AND active = true);

CREATE POLICY "Admins can read all templates"
ON public.message_templates
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Users delete their own public key"
ON public.user_public_keys
FOR DELETE
TO authenticated
USING (auth.uid() = user_id);