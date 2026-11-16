import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { clearClinicalDenial, currentClinicalEpoch, getClinicalScope } from "@/lib/session-scope";
import { useClinicalScope } from "./use-clinical-scope";
export { useClinicalScope };

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
  const qc = useQueryClient();
  const scope = useClinicalScope();
  const [hasAccess, setHasAccess] = useState<boolean>(false);
  const [loading, setLoading] = useState(true);
  const [rechecking, setRechecking] = useState(false);

  /**
   * Fresh, authoritative server check (the same predicate the server uses).
   * Only a check that STARTED after a denial may clear it.
   */
  const freshCheck = useCallback(
    async (userId: string, startedAt: number): Promise<boolean> => {
      const { data, error } = await supabase.rpc("has_clinical_access", { _user_id: userId });
      if (error || data !== true) return false;
      return clearClinicalDenial(qc, startedAt);
    },
    [qc],
  );

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
      const startedAt = currentClinicalEpoch();
      const { data } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .in("role", ["admin", "clinician"]);
      if (cancelled) return;
      const roleRows = Array.isArray(data) && data.length > 0;
      // A role row alone never overrides an authoritative denial.
      if (roleRows && getClinicalScope().denied) await freshCheck(user.id, startedAt);
      if (cancelled) return;
      setHasAccess(roleRows);
      setLoading(false);
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
  }, [user, authLoading, freshCheck]);

  /** "Check again" after a denial: a fresh server check, never a cached role. */
  const recheck = useCallback(async () => {
    if (!user) return false;
    const startedAt = currentClinicalEpoch();
    setRechecking(true);
    try {
      return await freshCheck(user.id, startedAt);
    } finally {
      setRechecking(false);
    }
  }, [user, freshCheck]);

  return {
    hasAccess: hasAccess && !scope.denied,
    loading,
    denied: scope.denied,
    recheck,
    rechecking,
    userId: user?.id ?? null,
  };
}

/**
 * Read-only viewer role — the user has a `viewer` row in `user_roles` but
 * neither `admin` nor `clinician`. When true, the UI must hide/disable
 * edit and delete affordances across the referral and note surfaces.
 *
 * Queries all of the user's roles as plain strings so the check is safe
 * even if the `viewer` value hasn't been added to the `app_role` enum
 * yet — in that case no rows match and the hook returns false.
 */
export function useIsViewer() {
  const { user, loading: authLoading } = useAuth();
  const [isViewer, setIsViewer] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) {
      setLoading(true);
      return;
    }
    if (!user) {
      setIsViewer(false);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const check = async () => {
      const { data } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id);
      if (cancelled) return;
      const roles = (data ?? []).map((r: { role: string }) => String(r.role));
      const hasEditor = roles.includes("admin") || roles.includes("clinician");
      setIsViewer(roles.includes("viewer") && !hasEditor);
      setLoading(false);
    };

    setLoading(true);
    void check();

    const channelKey = `user-roles-viewer-${user.id}-${Math.random().toString(36).slice(2, 10)}`;
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

  return { isViewer, loading };
}
