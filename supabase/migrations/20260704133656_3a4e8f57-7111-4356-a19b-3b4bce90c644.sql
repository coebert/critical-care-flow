
-- Public keys directory: any authenticated user can read to encrypt to peers
CREATE TABLE public.user_public_keys (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  public_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.user_public_keys TO authenticated;
GRANT ALL ON public.user_public_keys TO service_role;
ALTER TABLE public.user_public_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Any authenticated user can read public keys"
  ON public.user_public_keys FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users manage their own public key"
  ON public.user_public_keys FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update their own public key"
  ON public.user_public_keys FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER trg_user_public_keys_updated_at BEFORE UPDATE ON public.user_public_keys
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Private key material: only the owner can ever read/write
CREATE TABLE public.user_private_key_material (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  encrypted_private_key text NOT NULL,   -- base64 secretbox ciphertext
  kdf_salt text NOT NULL,                -- base64
  kdf_ops int NOT NULL,
  kdf_mem bigint NOT NULL,
  nonce text NOT NULL,                   -- base64 secretbox nonce
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_private_key_material TO authenticated;
GRANT ALL ON public.user_private_key_material TO service_role;
ALTER TABLE public.user_private_key_material ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owner reads own private key material"
  ON public.user_private_key_material FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Owner inserts own private key material"
  ON public.user_private_key_material FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Owner updates own private key material"
  ON public.user_private_key_material FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Owner deletes own private key material"
  ON public.user_private_key_material FOR DELETE TO authenticated USING (auth.uid() = user_id);
CREATE TRIGGER trg_user_private_key_material_updated_at BEFORE UPDATE ON public.user_private_key_material
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Encrypted note body columns on referral_notes
ALTER TABLE public.referral_notes
  ADD COLUMN body_ciphertext text,   -- base64 XChaCha20-Poly1305 ciphertext
  ADD COLUMN body_nonce text,        -- base64 nonce
  ADD COLUMN enc_version smallint;   -- 1 for current scheme

-- Per-recipient wrapped content keys (sealed-box to recipient's X25519 pub key)
CREATE TABLE public.referral_note_keys (
  note_id uuid NOT NULL REFERENCES public.referral_notes(id) ON DELETE CASCADE,
  recipient_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  wrapped_key text NOT NULL,  -- base64 sealed box of the content key
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (note_id, recipient_user_id)
);
CREATE INDEX referral_note_keys_recipient_idx ON public.referral_note_keys(recipient_user_id);
GRANT SELECT, INSERT, DELETE ON public.referral_note_keys TO authenticated;
GRANT ALL ON public.referral_note_keys TO service_role;
ALTER TABLE public.referral_note_keys ENABLE ROW LEVEL SECURITY;
-- Recipients read their own wrapped key; note author can also read (to know who got it)
CREATE POLICY "Recipient or author reads wrapped key"
  ON public.referral_note_keys FOR SELECT TO authenticated
  USING (
    recipient_user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.referral_notes n WHERE n.id = note_id AND n.author_id = auth.uid())
    OR public.has_role(auth.uid(), 'admin'::app_role)
  );
-- Only the note author can insert wrapped keys (at note-creation time)
CREATE POLICY "Note author inserts wrapped keys"
  ON public.referral_note_keys FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.referral_notes n WHERE n.id = note_id AND n.author_id = auth.uid())
  );
-- Only the note author or admin can delete (cascades from note delete anyway)
CREATE POLICY "Note author or admin deletes wrapped keys"
  ON public.referral_note_keys FOR DELETE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.referral_notes n WHERE n.id = note_id AND n.author_id = auth.uid())
    OR public.has_role(auth.uid(), 'admin'::app_role)
  );
