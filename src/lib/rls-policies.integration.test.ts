import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

/**
 * Automated RLS regression check. Introspects pg_policies on the live
 * database and asserts the policies protecting referrals, referral_tasks,
 * and the patient flag tables (end-of-life, scan-transfer, violence-risk)
 * still enforce the expected guards.
 *
 * Runs when PGHOST is set (dev sandbox / CI with DB access). Skips
 * gracefully in environments without psql or a database.
 *
 * Any drop of `has_clinical_access(...)`, any policy re-appearing with
 * `USING (true)` / `WITH CHECK (true)`, or an UPDATE policy that loses
 * its `WITH CHECK` clause will fail this test.
 */

type PolicyRow = {
  tablename: string;
  policyname: string;
  cmd: string;
  qual: string | null;
  with_check: string | null;
};

function fetchPolicies(): PolicyRow[] | null {
  if (!process.env.PGHOST) return null;
  let out: string;
  try {
    out = execFileSync(
      "psql",
      [
        "-Atc",
        `SELECT json_agg(row_to_json(t)) FROM (
           SELECT tablename, policyname, cmd, qual, with_check
             FROM pg_policies
            WHERE schemaname = 'public'
              AND tablename IN (
                'referrals','referral_tasks',
                'patient_end_of_life','patient_scan_transfer','patient_violence_risk'
              )
         ) t;`,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    return null;
  }
  const trimmed = out.trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed) as PolicyRow[];
}

const rows = fetchPolicies();
const describeIfDb = rows === null ? describe.skip : describe;

describeIfDb("RLS policy regression checks", () => {
  const byTable = (t: string) =>
    (rows ?? []).filter((r) => r.tablename === t);

  const has = (
    table: string,
    cmd: string,
    match: (r: PolicyRow) => boolean,
  ) => byTable(table).some((r) => r.cmd === cmd && match(r));

  // ---------------- patient flag tables ----------------
  for (const table of [
    "patient_end_of_life",
    "patient_scan_transfer",
    "patient_violence_risk",
  ] as const) {
    describe(table, () => {
      it("has no permissive TRUE policies", () => {
        for (const r of byTable(table)) {
          expect(r.qual, `${r.policyname}.qual`).not.toBe("true");
          expect(r.with_check, `${r.policyname}.with_check`).not.toBe("true");
        }
      });
      it("SELECT is gated by has_clinical_access(auth.uid())", () => {
        expect(
          has(table, "SELECT", (r) =>
            /has_clinical_access\(auth\.uid\(\)\)/.test(r.qual ?? ""),
          ),
        ).toBe(true);
      });
      it("INSERT WITH CHECK is gated by has_clinical_access(auth.uid())", () => {
        expect(
          has(table, "INSERT", (r) =>
            /has_clinical_access\(auth\.uid\(\)\)/.test(r.with_check ?? ""),
          ),
        ).toBe(true);
      });
      it("UPDATE has both USING and WITH CHECK gated by has_clinical_access", () => {
        expect(
          has(
            table,
            "UPDATE",
            (r) =>
              /has_clinical_access\(auth\.uid\(\)\)/.test(r.qual ?? "") &&
              /has_clinical_access\(auth\.uid\(\)\)/.test(r.with_check ?? ""),
          ),
        ).toBe(true);
      });
    });
  }

  // ---------------- referrals ----------------
  describe("referrals", () => {
    it("SELECT requires clinical access", () => {
      expect(
        has(
          "referrals",
          "SELECT",
          (r) => /has_clinical_access\(auth\.uid\(\)\)/.test(r.qual ?? ""),
        ),
      ).toBe(true);
    });
    it("INSERT WITH CHECK binds created_by to auth.uid() and requires clinical access", () => {
      expect(
        has("referrals", "INSERT", (r) => {
          const c = r.with_check ?? "";
          return (
            /has_clinical_access\(auth\.uid\(\)\)/.test(c) &&
            /auth\.uid\(\)\s*=\s*created_by/.test(c)
          );
        }),
      ).toBe(true);
    });
    it("has a live-row UPDATE policy with matching USING and WITH CHECK on deleted_at IS NULL", () => {
      expect(
        has("referrals", "UPDATE", (r) => {
          const u = r.qual ?? "";
          const c = r.with_check ?? "";
          return (
            /has_clinical_access\(auth\.uid\(\)\)/.test(u) &&
            /deleted_at IS NULL/.test(u) &&
            /has_clinical_access\(auth\.uid\(\)\)/.test(c) &&
            /deleted_at IS NULL/.test(c)
          );
        }),
      ).toBe(true);
    });
    it("DELETE is restricted to creator or admin", () => {
      expect(
        has("referrals", "DELETE", (r) => {
          const u = r.qual ?? "";
          return (
            /auth\.uid\(\)\s*=\s*created_by/.test(u) &&
            /has_role\(auth\.uid\(\),\s*'admin'/.test(u)
          );
        }),
      ).toBe(true);
    });
    it("has no permissive TRUE policies", () => {
      for (const r of byTable("referrals")) {
        expect(r.qual, `${r.policyname}.qual`).not.toBe("true");
        expect(r.with_check, `${r.policyname}.with_check`).not.toBe("true");
      }
    });
  });

  // ---------------- referral_tasks ----------------
  describe("referral_tasks", () => {
    it("SELECT requires clinical access AND live parent referral", () => {
      expect(
        has("referral_tasks", "SELECT", (r) => {
          const u = r.qual ?? "";
          return (
            /has_clinical_access\(auth\.uid\(\)\)/.test(u) &&
            /referrals/i.test(u) &&
            /deleted_at IS NULL/.test(u)
          );
        }),
      ).toBe(true);
    });
    it("INSERT binds created_by to auth.uid() and requires live parent referral", () => {
      expect(
        has("referral_tasks", "INSERT", (r) => {
          const c = r.with_check ?? "";
          return (
            /has_clinical_access\(auth\.uid\(\)\)/.test(c) &&
            /created_by\s*=\s*auth\.uid\(\)/.test(c) &&
            /deleted_at IS NULL/.test(c)
          );
        }),
      ).toBe(true);
    });
    it("UPDATE has matching USING and WITH CHECK (both require clinical access + live parent)", () => {
      expect(
        has("referral_tasks", "UPDATE", (r) => {
          const u = r.qual ?? "";
          const c = r.with_check ?? "";
          const guarded = (s: string) =>
            /has_clinical_access\(auth\.uid\(\)\)/.test(s) &&
            /deleted_at IS NULL/.test(s);
          return guarded(u) && guarded(c);
        }),
      ).toBe(true);
    });
    it("DELETE is admin only", () => {
      expect(
        has("referral_tasks", "DELETE", (r) =>
          /has_role\(auth\.uid\(\),\s*'admin'/.test(r.qual ?? ""),
        ),
      ).toBe(true);
    });
  });
});
