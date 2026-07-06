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
    const channel = supabase
      .channel(`user-roles-${user.id}`)
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
