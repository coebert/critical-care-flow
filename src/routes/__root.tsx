import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";

function NotFoundComponent() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Critical Care Connect" },
      { name: "description", content: "Critical Care Connect streamlines patient referral data capture and analysis for critical care teams." },
      { name: "author", content: "Lovable" },
      // NHS DTAC / NCSC — client-enforceable security hints. Server-side
      // HTTP headers (HSTS, X-Frame-Options, CSP) are set by the hosting
      // platform; these meta equivalents cover what a rendered document
      // can enforce on its own.
      { name: "referrer", content: "strict-origin-when-cross-origin" },
      { httpEquiv: "X-Content-Type-Options", content: "nosniff" },
      { httpEquiv: "X-UA-Compatible", content: "IE=edge" },
      { httpEquiv: "Permissions-Policy", content: "camera=(), microphone=(), geolocation=(), payment=()" },
      { property: "og:title", content: "Critical Care Connect" },
      { property: "og:description", content: "Critical Care Connect streamlines patient referral data capture and analysis for critical care teams." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:site", content: "@Lovable" },
      { name: "twitter:title", content: "Critical Care Connect" },
      { name: "twitter:description", content: "Critical Care Connect streamlines patient referral data capture and analysis for critical care teams." },
      // og:image intentionally omitted at the root — leaf routes may add
      // their own; otherwise the hosting platform injects a screenshot.
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  // Startup sanity check: verify the libsodium build ships Argon2 password
  // hashing. If a future dep change ever swaps back to the slim build,
  // every enable/unlock flow would fail cryptically — surface it up front.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ verifySodiumPasswordHashing }, { toast }] = await Promise.all([
        import("@/lib/e2e-crypto"),
        import("sonner"),
      ]);
      const health = await verifySodiumPasswordHashing();
      if (cancelled || health.ok) return;
      const detail = health.error ? ` (${health.error})` : "";
      const missing = health.missing.join(", ");
      console.error(
        `[e2e] libsodium password hashing unavailable — missing: ${missing}${detail}`,
      );
      toast.error("End-to-end encryption is unavailable in this build", {
        description:
          `The libsodium password-hashing functions we need (${missing}) aren't available in your browser. ` +
          `Encrypted notes can't be enabled, unlocked, or read until this is fixed. ` +
          `Please refresh the page — if it keeps happening, contact support.`,
        duration: Infinity,
        id: "sodium-health",
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      <Outlet />
    </QueryClientProvider>
  );
}
