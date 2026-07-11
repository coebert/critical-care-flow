import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

// Security-focused restrictions. Rationale:
// - localStorage token/secret/key writes → session material must live in
//   memory or IndexedDB scoped to the tab, never in an origin-persistent
//   store an XSS can read (see docs/SECURE_DEVELOPMENT.md, P3 sweep 2026-07).
// - dangerouslySetInnerHTML → we never render server/user HTML; ban site-wide.
// - eval / new Function → CSP violates them anyway; ban at source too.
// - Top-level `client.server` import from `*.functions.ts` → the whole module
//   ships to the client bundle (only the handler body is stripped by the
//   split transform). Load `supabaseAdmin` inside the handler via dynamic
//   import instead. See <server-side-modern>.
const securityRestrictedSyntax = [
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.object.name='localStorage'][callee.property.name='setItem'][arguments.0.type='Literal'][arguments.0.value=/token|secret|key|password|jwt|bearer/i]",
    message:
      "Do not persist tokens, secrets, or key material in localStorage — XSS can read the whole origin store. Use sessionStorage-less memory, IndexedDB with per-tab keys, or an httpOnly cookie set by a server function.",
  },
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message:
      "dangerouslySetInnerHTML is banned. Render text as children, or sanitise with a vetted library and justify in code review.",
  },
  {
    selector: "CallExpression[callee.name='eval']",
    message: "eval() is banned — violates our CSP and is unreviewable.",
  },
  {
    selector: "NewExpression[callee.name='Function']",
    message: "new Function() is banned — same reasons as eval().",
  },
];

export default tseslint.config(
  { ignores: ["dist", ".output", ".vinxi"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
        },
      ],
      "no-restricted-syntax": ["error", ...securityRestrictedSyntax],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  // Server-function modules ship to the client bundle (only handler bodies
  // are stripped). A top-level `@/integrations/supabase/client.server`
  // import leaks service-role code paths to browsers. Force dynamic import
  // inside the handler.
  {
    files: ["**/*.functions.ts", "**/*.functions.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package.",
            },
            {
              name: "@/integrations/supabase/client.server",
              message:
                "Do not top-level import `client.server` from a *.functions.ts module — the file ships to the client bundle. Load it inside the handler: `const { supabaseAdmin } = await import('@/integrations/supabase/client.server')`.",
            },
          ],
          patterns: [
            {
              group: ["**/client.server"],
              message:
                "Do not top-level import `client.server` from a *.functions.ts module — service-role code paths would ship to the client bundle. Use `await import('@/integrations/supabase/client.server')` inside the handler.",
            },
          ],
        },
      ],
    },
  },
  // Config, tests, and the ESLint config itself legitimately touch things
  // the rules above would flag. Scope exceptions narrowly.
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx", "e2e/**/*.ts"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
  eslintPluginPrettier,
);
