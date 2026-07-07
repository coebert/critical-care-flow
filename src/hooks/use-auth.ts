import { useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export interface AuthState {
  user: User | null;
  session: Session | null;
  loading: boolean;
}

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    user: null,
    session: null,
    loading: true,
  });

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({ user: session?.user ?? null, session, loading: false });
    });
    supabase.auth.getSession().then(({ data }) => {
      setState({
        user: data.session?.user ?? null,
        session: data.session,
        loading: false,
      });
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return state;
}

export function useRole(role: "admin" | "clinician") {
  const { user, loading: authLoading } = useAuth();
  const [hasRole, setHasRole] = useState<boolean>(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Wait for auth to resolve before deciding — otherwise a freshly
    // mounted consumer briefly sees user=null and would incorrectly
    // conclude the user has no role (triggering guards like AdminOnly
    // to redirect before the session hydrates).
    if (authLoading) {
      setLoading(true);
      return;
    }
    if (!user) {
      setHasRole(false);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const check = async () => {
      const { data } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .eq("role", role)
        .maybeSingle();
      if (!cancelled) {
        setHasRole(!!data);
        setLoading(false);
      }
    };

    setLoading(true);
    void check();

    // Subscribe to role changes for this user so revocations/grants take
    // effect immediately without waiting for the next identity transition.
    // The RLS "read own roles" policy makes this scoped filter safe.
    // Use a per-instance nonce so multiple hook consumers on the same page
    // (e.g. the sidebar plus a route component) don't collide on the same
    // channel name — supabase-js caches by name and would then throw
    // "cannot add `postgres_changes` callbacks after `subscribe()`".
    const channelKey = `user-roles-${user.id}-${Math.random().toString(36).slice(2, 10)}`;
    const channel = supabase
      .channel(channelKey)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "user_roles",
          filter: `user_id=eq.${user.id}`,
        },
        () => {
          void check();
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [user, role, authLoading]);

  return { hasRole, loading };
}

/**
 * Returns true when the signed-in user has clinical access, i.e. an
 * 'admin' or 'clinician' role. Mirrors the server-side
 * `public.has_clinical_access(uuid)` predicate used by every referral
 * RLS policy — the UI gate here just prevents non-clinical staff from
 * even opening the referral surfaces, where every query would otherwise
 * silently return zero rows under RLS.
 *
 * Subscribes to the user's rows in `user_roles` so grants/revocations
 * take effect without a reload (mirrors `useRole`).
 */
export function useClinicalAccess() {
  const { user, loading: authLoading } = useAuth();
  const [hasAccess, setHasAccess] = useState<boolean>(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) {
      setLoading(true);
      return;
    }
    if (!user) {
      setHasAccess(false);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const check = async () => {
      const { data } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .in("role", ["admin", "clinician"]);
      if (!cancelled) {
        setHasAccess(Array.isArray(data) && data.length > 0);
        setLoading(false);
      }
    };

    setLoading(true);
    void check();

    const channelKey = `user-roles-clinical-${user.id}-${Math.random().toString(36).slice(2, 10)}`;
    const channel = supabase
      .channel(channelKey)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "user_roles",
          filter: `user_id=eq.${user.id}`,
        },
        () => {
          void check();
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [user, authLoading]);

  return { hasAccess, loading };
}
