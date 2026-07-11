CREATE OR REPLACE FUNCTION public.webauthn_challenges_prune()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
BEGIN
  IF random() < 0.01 THEN
    DELETE FROM public.webauthn_challenges
      WHERE expires_at < now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS webauthn_challenges_prune_trg ON public.webauthn_challenges;
CREATE TRIGGER webauthn_challenges_prune_trg
  AFTER INSERT ON public.webauthn_challenges
  FOR EACH ROW
  EXECUTE FUNCTION public.webauthn_challenges_prune();

REVOKE ALL ON FUNCTION public.webauthn_challenges_prune() FROM PUBLIC, anon, authenticated;