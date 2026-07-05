
-- webauthn_credentials: one row per registered passkey
CREATE TABLE public.webauthn_credentials (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key BYTEA NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  transports TEXT[] NOT NULL DEFAULT '{}',
  device_label TEXT,
  aaguid TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX webauthn_credentials_user_id_idx ON public.webauthn_credentials(user_id);

GRANT SELECT, DELETE ON public.webauthn_credentials TO authenticated;
GRANT ALL ON public.webauthn_credentials TO service_role;

ALTER TABLE public.webauthn_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own passkeys"
  ON public.webauthn_credentials FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own passkeys"
  ON public.webauthn_credentials FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- webauthn_challenges: short-lived ceremony state, server-only
CREATE TABLE public.webauthn_challenges (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  challenge TEXT NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  email_norm TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('registration','authentication')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '2 minutes')
);

CREATE INDEX webauthn_challenges_user_id_idx ON public.webauthn_challenges(user_id);
CREATE INDEX webauthn_challenges_email_idx ON public.webauthn_challenges(email_norm);
CREATE INDEX webauthn_challenges_expires_idx ON public.webauthn_challenges(expires_at);

GRANT ALL ON public.webauthn_challenges TO service_role;

ALTER TABLE public.webauthn_challenges ENABLE ROW LEVEL SECURITY;
-- No policies for anon/authenticated: table is only reachable via service role.
