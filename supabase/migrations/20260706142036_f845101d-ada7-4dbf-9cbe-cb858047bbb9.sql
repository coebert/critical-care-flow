-- Match the existing INSERT/UPDATE policies on webauthn_credentials with the
-- corresponding table-level grants. Without these, passkey registration via
-- the RLS-scoped client fails with permission denied even though the policy
-- would allow it.
GRANT INSERT, UPDATE ON public.webauthn_credentials TO authenticated;