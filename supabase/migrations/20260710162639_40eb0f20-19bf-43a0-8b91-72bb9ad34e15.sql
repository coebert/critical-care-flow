
-- Harden PHI-bearing referral tables: remove anon privileges entirely.
-- RLS already blocks anon, but revoking table grants ensures PostgREST
-- rejects unauthenticated requests at the privilege layer too.
REVOKE ALL ON public.referrals FROM anon;
REVOKE ALL ON public.referral_notes FROM anon;
REVOKE ALL ON public.referral_note_keys FROM anon;
REVOKE ALL ON public.referral_messages FROM anon;
REVOKE ALL ON public.referral_tasks FROM anon;
REVOKE ALL ON public.patients FROM anon;

-- Re-assert the minimum authenticated + service_role grants the app needs.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.referrals TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.referral_notes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.referral_note_keys TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.referral_messages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.referral_tasks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.patients TO authenticated;

GRANT ALL ON public.referrals TO service_role;
GRANT ALL ON public.referral_notes TO service_role;
GRANT ALL ON public.referral_note_keys TO service_role;
GRANT ALL ON public.referral_messages TO service_role;
GRANT ALL ON public.referral_tasks TO service_role;
GRANT ALL ON public.patients TO service_role;
