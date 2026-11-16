import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Static guard: internal maintenance / throttling RPCs are executable by
 * service_role only. Every call site must therefore use the server-held
 * `supabaseAdmin` client, never the browser client or a user-scoped client.
 */
const SERVICE_ONLY_RPCS = [
  "expire_stale_notifications",
  "begin_auth_attempt",
  "finalize_auth_attempt",
  "begin_privileged_action",
  "finalize_privileged_action",
  "get_bridge_cron_state",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !p.endsWith("types.ts")) out.push(p);
  }
  return out;
}

const files = walk(join(process.cwd(), "src"));

describe("service-role-only RPC call sites", () => {
  for (const fn of SERVICE_ONLY_RPCS) {
    it(`${fn} is only called through supabaseAdmin`, () => {
      const offenders: string[] = [];
      for (const f of files) {
        const src = readFileSync(f, "utf8");
        const re = new RegExp(`\\.rpc\\(\\s*["']${fn}["']`, "g");
        let m: RegExpExecArray | null;
        while ((m = re.exec(src))) {
          // The receiver expression immediately before `.rpc(` (allowing a cast
          // and line breaks) must be supabaseAdmin.
          const before = src.slice(Math.max(0, m.index - 80), m.index);
          if (!/supabaseAdmin(\s+as\s+any\))?\s*$/.test(before)) offenders.push(f);
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  it("the sign-in page no longer calls any throttle RPC directly", () => {
    const src = readFileSync(join(process.cwd(), "src/routes/auth.tsx"), "utf8");
    expect(src).not.toMatch(/rpc\(\s*["'](begin|finalize)_auth_attempt/);
  });
});
