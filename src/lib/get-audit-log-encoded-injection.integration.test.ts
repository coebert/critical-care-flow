import { describe, it, expect } from "vitest";
import { runGetAuditLog } from "./admin.functions";

/**
 * Server-side integration: `getAuditLog` must accept URL-encoded and
 * double-URL-encoded injection-shaped filter strings without leaking
 * sensitive plaintext, dropping into raw SQL, or surfacing driver-level
 * error messages to the caller.
 *
 * The handler never percent-decodes filters itself — HTTP layer already
 * decoded the querystring once, so a caller who submits `%2527` is
 * asking for the *literal* seven-character string `%2527`, and a caller
 * who submits `%27` (still encoded once by us for test purposes) is
 * asking for the literal `%27`. Both must reach the query builder
 * verbatim and never be spliced into SQL.
 *
 * Every assertion here rides on the same rails as the sibling suites:
 *  - Response is well-formed (page shape intact).
 *  - Payload passes the crypto-suffix + sensitive-plaintext sweep.
 *  - Response text contains none of the fixture markers.
 *  - Query-builder call log records the filter arg passed *unchanged*.
 *  - When the underlying DB call errors, only the fixed friendly
 *    message escapes — never the driver's raw error.
 */

// ---------------------------------------------------------------------
// Fixture rows with dangerous plaintext + crypto-suffix keys.
// ---------------------------------------------------------------------

const RAW_ROWS = [
  {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    user_id: "11111111-1111-1111-1111-111111111111",
    action: "create",
    entity: "referral",
    entity_id: "r1",
    created_at: "2026-07-11T10:00:00.000Z",
    diff: {
      hospital_number: "H-ENC-PLAIN-1",
      hospital_number_enc: "v1:HN-ENC-CIPHER-1",
      hospital_number_hash: "hn-enc-hash-1",
      reason_for_referral: { old: "RR-ENC-OLD-1", new: "RR-ENC-NEW-1" },
      reason_for_referral_ciphertext: "rr-enc-cipher-1",
      reason_for_referral_nonce: "IV-RR-ENC-1",
      body: "NOTE-ENC-BODY-1",
      body_ciphertext: "body-enc-cipher-1",
      body_nonce: "IV-BODY-ENC-1",
      allergies: { old: "AL-ENC-OLD-1", new: "AL-ENC-NEW-1" },
      patient_initials: "ZZ-ENC-1",
    },
  },
];

const FORBIDDEN_MARKERS = [
  "H-ENC-PLAIN-1",
  "v1:HN-ENC-CIPHER-1",
  "hn-enc-hash-1",
  "RR-ENC-OLD-1",
  "RR-ENC-NEW-1",
  "rr-enc-cipher-1",
  "IV-RR-ENC-1",
  "NOTE-ENC-BODY-1",
  "body-enc-cipher-1",
  "IV-BODY-ENC-1",
  "AL-ENC-OLD-1",
  "AL-ENC-NEW-1",
  "ZZ-ENC-1",
];

const CRYPTO_SUFFIXES = ["_enc", "_ciphertext", "_nonce", "_hash"];
const SENSITIVE_KEYS = new Set([
  "hospital_number",
  "patient_initials",
  "reason_for_referral",
  "reason_for_bed",
  "past_medical_history",
  "past_surgical_history",
  "social_history",
  "baseline_function",
  "proposed_procedure",
  "body",
  "dnacpr_details",
  "dnacpr_reason",
  "tep_details",
  "allergies",
  "infection_organism",
]);

function findLeaks(node: unknown, path: string[] = []): string[] {
  const leaks: string[] = [];
  if (Array.isArray(node)) {
    node.forEach((v, i) => leaks.push(...findLeaks(v, [...path, String(i)])));
    return leaks;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const here = [...path, key];
      if (CRYPTO_SUFFIXES.some((s) => key.endsWith(s))) {
        leaks.push(`crypto key leaked at ${here.join(".")}`);
        continue;
      }
      if (SENSITIVE_KEYS.has(key)) {
        const isRedactedLeaf = (v: unknown) => v === null || v === "[encrypted]";
        const isRedactedDiff =
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          Object.entries(value as Record<string, unknown>).every(
            ([k, v]) => (k === "old" || k === "new") && isRedactedLeaf(v),
          );
        if (!isRedactedLeaf(value) && !isRedactedDiff) {
          leaks.push(
            `sensitive plaintext leaked at ${here.join(".")}: ${JSON.stringify(value)}`,
          );
        }
        continue;
      }
      leaks.push(...findLeaks(value, here));
    }
  }
  return leaks;
}

function assertClean(where: string, payload: unknown) {
  const leaks = findLeaks(payload);
  expect(
    leaks,
    `[${where}] leaked ${leaks.length} field(s):\n  ${leaks.join("\n  ")}`,
  ).toEqual([]);
  const serialised = JSON.stringify(payload);
  for (const m of FORBIDDEN_MARKERS) {
    expect(
      serialised.includes(m),
      `[${where}] response contained forbidden marker "${m}"`,
    ).toBe(false);
  }
}

function assertPageShape(where: string, page: any) {
  expect(page, `[${where}] page missing`).toBeTruthy();
  expect(Array.isArray(page.rows), `[${where}] rows not array`).toBe(true);
  expect(typeof page.hasMore).toBe("boolean");
  expect(typeof page.nextOffset).toBe("number");
  expect(typeof page.total).toBe("number");
  expect(typeof page.limit).toBe("number");
  expect(typeof page.offset).toBe("number");
  expect(["created_at", "action", "entity"]).toContain(page.sortBy);
  expect(["asc", "desc"]).toContain(page.sortDir);
}

// Query-builder stub — records every builder call so we can prove the
// filter arg is passed verbatim (never spliced into SQL, never decoded).
function makeRecordingAdmin(opts: {
  profilesResult?: { data: Array<{ id: string }> | null; error: unknown };
  referralsResult?: { data: Array<{ id: string }> | null; error: unknown };
  auditResult?: { data: typeof RAW_ROWS | null; error: unknown; count: number };
}) {
  const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];

  function makeChain(table: string, terminal: unknown) {
    const ops: Array<[string, unknown[]]> = [];
    const record: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "range" || prop === "limit") {
            return async (...args: unknown[]) => {
              ops.push([prop, args]);
              return terminal;
            };
          }
          if (prop === "then") {
            return (fn: (v: unknown) => unknown) => fn(terminal);
          }
          return (...args: unknown[]) => {
            ops.push([prop, args]);
            return record;
          };
        },
      },
    );
    calls.push({ table, ops });
    return record;
  }

  const auditResult =
    opts.auditResult ?? { data: RAW_ROWS, error: null, count: RAW_ROWS.length };
  const profilesResult = opts.profilesResult ?? { data: [], error: null };
  const referralsResult = opts.referralsResult ?? { data: [], error: null };

  const admin = {
    from: (table: string) => {
      if (table === "audit_log") return makeChain(table, auditResult);
      if (table === "profiles") return makeChain(table, profilesResult);
      if (table === "referrals") return makeChain(table, referralsResult);
      return makeChain(table, { data: [], error: null });
    },
  };
  return { admin, calls };
}

// ---------------------------------------------------------------------
// Encoded / double-encoded injection-shaped payloads.
//
// Each entry is: [label, raw-string-as-caller-would-pass-it]. Nothing
// here is pre-decoded on our side — the value is exactly what a HTTP
// caller would put on the wire after standard URL parsing. Double-
// encoded variants (%2527, %252527) are the string a caller sends when
// they've deliberately encoded a `%` so the eventual literal contains
// escape characters. Handler must treat every one as opaque text.
// ---------------------------------------------------------------------

const ENCODED_INJECTIONS: Array<[string, string]> = [
  ["single-quote %27", "%27 OR 1=1 --"],
  ["double-encoded quote %2527", "%2527 OR 1=1 --"],
  ["triple-encoded quote %252527", "%252527 OR 1=1 --"],
  ["encoded semicolon %3B DROP", "%3B DROP TABLE audit_log %3B"],
  ["encoded parentheses union", "%28SELECT%20*%20FROM%20auth.users%29"],
  ["encoded comment %2D%2D", "admin%2D%2D"],
  ["encoded null byte %00", "smith%00.%00"],
  ["encoded newline %0A%0D", "smith%0A%0DDROP"],
  ["encoded pg-array cast %3A%3A", "1%3A%3Aint OR true"],
  ["encoded backslash quote %5C%27", "%5C%27 OR %5C%27a%5C%27=%5C%27a"],
  ["encoded percent literal %25", "50%25 off"],
  ["encoded unicode %E2%80%99", "O%E2%80%99Brien"],
  ["mixed-case %2f %2F", "path%2fwith%2Fslashes"],
  ["encoded LDAP-style", "%2A%29%28uid%3D%2A%29"],
  ["double-encoded UNION", "%2555NION SELECT NULL"],
];

describe("getAuditLog — URL-encoded / double-encoded injection-shaped clinician values", () => {
  for (const [label, payload] of ENCODED_INJECTIONS) {
    it(`[clinician:name-branch] ${label} → passed verbatim to ilike, response redacted`, async () => {
      const { admin, calls } = makeRecordingAdmin({});
      const page = await runGetAuditLog({ clinician: payload } as any, admin);

      // Handler treats non-UUID clinician as a name → profiles.ilike.
      const profiles = calls.find((c) => c.table === "profiles");
      expect(profiles, "profiles lookup must fire for name clinician").toBeTruthy();
      const ilikeOp = profiles!.ops.find(([m]) => m === "ilike");
      expect(ilikeOp?.[1][0]).toBe("full_name");
      // Value passed VERBATIM (no decoding, no rewriting, no interpretation).
      expect(String(ilikeOp?.[1][1] ?? "")).toBe(`%${payload}%`);

      // Empty profiles → sentinel zero-UUID applied so DB returns []
      // when a real DB is behind this stub. Our stub still returns
      // fixture rows so the redaction contract is exercised.
      const audit = calls.find((c) => c.table === "audit_log")!;
      const inOp = audit.ops.find(([m]) => m === "in");
      expect(inOp?.[1][1]).toEqual(["00000000-0000-0000-0000-000000000000"]);

      assertPageShape(`clinician ${label}`, page);
      assertClean(`clinician ${label}`, page);
    });
  }
});

describe("getAuditLog — URL-encoded / double-encoded injection-shaped specialty values", () => {
  for (const [label, payload] of ENCODED_INJECTIONS) {
    it(`[specialty] ${label} → passed verbatim to ilike, response redacted`, async () => {
      const { admin, calls } = makeRecordingAdmin({});
      const page = await runGetAuditLog({ specialty: payload } as any, admin);

      const refs = calls.find((c) => c.table === "referrals");
      expect(refs, "referrals lookup must fire for specialty").toBeTruthy();
      const ilikeOp = refs!.ops.find(([m]) => m === "ilike");
      expect(ilikeOp?.[1][0]).toBe("referring_specialty");
      expect(String(ilikeOp?.[1][1] ?? "")).toBe(`%${payload}%`);

      assertPageShape(`specialty ${label}`, page);
      assertClean(`specialty ${label}`, page);
    });
  }
});

describe("getAuditLog — URL-encoded / double-encoded injection-shaped entity values", () => {
  for (const [label, payload] of ENCODED_INJECTIONS) {
    it(`[entity] ${label} → passed verbatim to eq, response redacted`, async () => {
      const { admin, calls } = makeRecordingAdmin({});
      const page = await runGetAuditLog({ entity: payload } as any, admin);

      const audit = calls.find((c) => c.table === "audit_log")!;
      const eqOps = audit.ops.filter(([m]) => m === "eq");
      const entityEq = eqOps.find(([, args]) => args[0] === "entity");
      expect(entityEq, "entity eq must be applied").toBeTruthy();
      expect(entityEq![1][1]).toBe(payload);

      assertPageShape(`entity ${label}`, page);
      assertClean(`entity ${label}`, page);
    });
  }
});

describe("getAuditLog — DB error surface leaks nothing", () => {
  it("clinician-name branch: profiles error → friendly message only, no marker or driver detail", async () => {
    // Driver-shaped error body that contains SQL fragments & a fixture
    // marker. Handler must wrap via safeError so none of this escapes.
    const driverError = {
      message:
        "column profiles.full_name violates constraint xyz — near \"H-ENC-PLAIN-1\" at 'SELECT * FROM profiles WHERE full_name ILIKE $1'",
      code: "42601",
      details: "hn-enc-hash-1 leaked-detail",
      hint: "check your query",
    };
    const { admin } = makeRecordingAdmin({
      profilesResult: { data: null, error: driverError },
    });

    let caught: unknown;
    try {
      await runGetAuditLog(
        { clinician: "%27 OR 1=1 --" } as any,
        admin,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught, "handler must throw on DB error").toBeTruthy();
    const surface = JSON.stringify({
      message: (caught as Error)?.message,
      // Some safeError implementations attach `.cause` — sweep that too.
      cause: (caught as any)?.cause,
    });
    // No fixture marker or SQL fragment leaks to the caller.
    for (const m of FORBIDDEN_MARKERS) {
      expect(surface.includes(m), `error surface leaked marker "${m}"`).toBe(false);
    }
    expect(surface.toLowerCase()).not.toContain("select *");
    expect(surface.toLowerCase()).not.toContain("ilike $");
    expect(surface).not.toContain("42601");
    // Friendly message is exposed instead.
    expect((caught as Error).message).toBe("Failed to load audit log.");
  });

  it("main audit_log query error → friendly message only", async () => {
    const driverError = {
      message: "syntax error near 'RR-ENC-OLD-1' — column body_ciphertext",
      code: "42P01",
      details: "IV-BODY-ENC-1",
    };
    const { admin } = makeRecordingAdmin({
      auditResult: { data: null, error: driverError, count: 0 },
    });

    let caught: unknown;
    try {
      await runGetAuditLog({ entity: "%27 OR 1=1 --" } as any, admin);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    const surface = JSON.stringify({
      message: (caught as Error)?.message,
      cause: (caught as any)?.cause,
    });
    for (const m of FORBIDDEN_MARKERS) {
      expect(surface.includes(m), `error surface leaked marker "${m}"`).toBe(false);
    }
    expect(surface).not.toContain("42P01");
    expect(surface.toLowerCase()).not.toContain("syntax error");
    expect((caught as Error).message).toBe("Failed to load audit log.");
  });
});

describe("getAuditLog — encoded payloads across multiple filters at once", () => {
  it("clinician + specialty + entity + action, all encoded — every arg verbatim, response redacted", async () => {
    const clinician = "%27%3B%20SELECT%20*%20FROM%20auth.users%3B%20--";
    const specialty = "%2528SELECT%2520pg_sleep%25281%2529%2529";
    const entity = "referral%00";
    const { admin, calls } = makeRecordingAdmin({
      profilesResult: {
        data: [{ id: "11111111-1111-1111-1111-111111111111" }],
        error: null,
      },
      referralsResult: { data: [{ id: "r1" }], error: null },
    });

    const page = await runGetAuditLog(
      {
        clinician,
        specialty,
        entity,
        action: "update",
      } as any,
      admin,
    );

    const profiles = calls.find((c) => c.table === "profiles")!;
    expect(String(profiles.ops.find(([m]) => m === "ilike")?.[1][1] ?? "")).toBe(
      `%${clinician}%`,
    );
    const refs = calls.find((c) => c.table === "referrals")!;
    expect(String(refs.ops.find(([m]) => m === "ilike")?.[1][1] ?? "")).toBe(
      `%${specialty}%`,
    );
    const audit = calls.find((c) => c.table === "audit_log")!;
    const eqs = audit.ops.filter(([m]) => m === "eq").map(([, a]) => a);
    expect(eqs.some(([c, v]) => c === "entity" && v === entity)).toBe(true);
    expect(eqs.some(([c, v]) => c === "action" && v === "update")).toBe(true);

    assertPageShape("stacked encoded filters", page);
    assertClean("stacked encoded filters", page);
  });
});
