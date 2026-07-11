import { createStart, createMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";
import { withSecurityHeaders } from "./lib/security-headers.server";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-attacher";

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

// Batch B / P2 hardening: apply HSTS, nosniff, framing, referrer, and
// Permissions-Policy headers to every response. Runs after `errorMiddleware`
// so error pages get them too. Existing headers on the response are kept.
const securityHeadersMiddleware = createMiddleware().server(async ({ next }) => {
  const result = await next();
  if (result instanceof Response) {
    return withSecurityHeaders(result);
  }
  const bag = result as { response?: Response };
  if (bag.response instanceof Response) {
    bag.response = withSecurityHeaders(bag.response);
  }
  return result;
});

export const startInstance = createStart(() => ({
  functionMiddleware: [attachSupabaseAuth],
  requestMiddleware: [errorMiddleware, securityHeadersMiddleware],
}));
