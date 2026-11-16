import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { noteClinicalResult } from "./lib/session-scope";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { installSessionRetention } from "./lib/session-retention";

export const getRouter = () => {
  // Swap in the "Keep me signed in" auth storage before the auth client
  // first reads it (see session-retention.ts).
  if (typeof window !== "undefined") installSessionRetention();
  // Any authoritative clinical-role denial seen by any query or mutation
  // closes the shared clinical gate (browser only; see session-scope.ts).
  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (e) => noteClinicalResult(queryClient, e),
      onSuccess: (d) => noteClinicalResult(queryClient, d),
    }),
    mutationCache: new MutationCache({
      onError: (e) => noteClinicalResult(queryClient, e),
      onSuccess: (d) => noteClinicalResult(queryClient, d),
    }),
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  return router;
};
