import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { noteClinicalResult } from "./lib/session-scope";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
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
