import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Note } from "@/components/note-item";
import { decryptNote as e2eDecryptNote } from "@/lib/e2e-crypto";

interface E2ESessionSlice {
  isUnlocked: boolean;
  publicKey: string | null;
  privateKey: Uint8Array | null;
}

/**
 * Decrypt raw ciphertext note rows into the shape the UI renders, and fetch
 * author names in the background. Cancels in-flight decrypts when inputs
 * change so a slow decryption can't overwrite a newer one.
 */
export function useDecryptedNotes(
  rawNotes: readonly any[] | undefined,
  e2e: E2ESessionSlice,
) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [authors, setAuthors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!rawNotes) return;
    let cancelled = false;

    const sorted = [...rawNotes].sort(
      (a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );

    const decryptRow = async (n: any): Promise<Note> => {
      if (n.body_ciphertext && n.body_nonce) {
        if (!n.wrapped_key) return { ...n, body: null, _e2eStatus: "e2e-no-key" };
        if (!e2e.isUnlocked || !e2e.privateKey || !e2e.publicKey) {
          return { ...n, body: null, _e2eStatus: "e2e-locked" };
        }
        try {
          const body = await e2eDecryptNote(
            { body_ciphertext: n.body_ciphertext, body_nonce: n.body_nonce, wrapped_key: n.wrapped_key },
            { publicKey: e2e.publicKey, privateKey: e2e.privateKey },
          );
          return { ...n, body, _e2eStatus: "e2e-decrypted" };
        } catch {
          return { ...n, body: null, _e2eStatus: "e2e-failed" };
        }
      }
      if (n.body_enc) return { ...n, _e2eStatus: "legacy-server-enc" };
      return { ...n, _e2eStatus: "plaintext" };
    };

    (async () => {
      const decrypted = await Promise.all(sorted.map(decryptRow));
      if (!cancelled) setNotes(decrypted);
    })();

    const ids = Array.from(new Set(sorted.map((n: any) => n.author_id))) as string[];
    if (ids.length) {
      supabase
        .from("profiles")
        .select("id,full_name")
        .in("id", ids)
        .then(({ data: ps }) => {
          if (cancelled || !ps) return;
          const map: Record<string, string> = {};
          ps.forEach((p) => { map[p.id] = p.full_name ?? "Clinician"; });
          setAuthors((cur) => ({ ...cur, ...map }));
        });
    }

    return () => { cancelled = true; };
  }, [rawNotes, e2e.isUnlocked, e2e.privateKey, e2e.publicKey]);

  return { notes, authors };
}
