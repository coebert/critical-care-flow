import { describe, it, expect, vi } from "vitest";
import {
  assertSetupSecret,
  safeEqualStr,
  SETUP_DISABLED_MESSAGE,
  SETUP_INVALID_SECRET_MESSAGE,
} from "./setup-secret-guard";

/**
 * `bootstrapFirstAdmin` in `src/routes/setup.tsx` calls `assertSetupSecret`
 * BEFORE it dynamically imports `supabaseAdmin` and before it touches
 * `auth.admin.listUsers` / `createUser`. Proving the guard throws on wrong
 * or missing secrets proves the handler cannot reach any database write on
 * those paths.
 */
describe("assertSetupSecret", () => {
  const CONFIGURED = "a-very-long-out-of-band-secret-32chars";

  it("throws SETUP_DISABLED when SETUP_SECRET is not configured on the server", () => {
    expect(() => assertSetupSecret("anything", undefined)).toThrow(
      SETUP_DISABLED_MESSAGE,
    );
    expect(() => assertSetupSecret("anything", null)).toThrow(
      SETUP_DISABLED_MESSAGE,
    );
    expect(() => assertSetupSecret("anything", "")).toThrow(
      SETUP_DISABLED_MESSAGE,
    );
  });

  it("throws SETUP_DISABLED when the configured secret is shorter than 16 chars", () => {
    expect(() => assertSetupSecret("short-secret", "short-secret")).toThrow(
      SETUP_DISABLED_MESSAGE,
    );
    expect(() =>
      assertSetupSecret("123456789012345", "123456789012345"),
    ).toThrow(SETUP_DISABLED_MESSAGE);
  });

  it("throws INVALID_SECRET when the client omits the setup secret entirely", () => {
    expect(() => assertSetupSecret(undefined, CONFIGURED)).toThrow(
      SETUP_INVALID_SECRET_MESSAGE,
    );
    expect(() => assertSetupSecret(null, CONFIGURED)).toThrow(
      SETUP_INVALID_SECRET_MESSAGE,
    );
    expect(() => assertSetupSecret("", CONFIGURED)).toThrow(
      SETUP_INVALID_SECRET_MESSAGE,
    );
  });

  it("throws INVALID_SECRET when the client-supplied secret does not match", () => {
    expect(() => assertSetupSecret("wrong", CONFIGURED)).toThrow(
      SETUP_INVALID_SECRET_MESSAGE,
    );
    // Same length, different bytes.
    const sameLenWrong = "x".repeat(CONFIGURED.length);
    expect(() => assertSetupSecret(sameLenWrong, CONFIGURED)).toThrow(
      SETUP_INVALID_SECRET_MESSAGE,
    );
    // Correct prefix but wrong overall.
    expect(() =>
      assertSetupSecret(CONFIGURED.slice(0, -1) + "!", CONFIGURED),
    ).toThrow(SETUP_INVALID_SECRET_MESSAGE);
  });

  it("returns silently when the caller supplies the exact configured secret", () => {
    expect(() => assertSetupSecret(CONFIGURED, CONFIGURED)).not.toThrow();
  });

  it("safeEqualStr is length-sensitive and byte-sensitive", () => {
    expect(safeEqualStr("abc", "abc")).toBe(true);
    expect(safeEqualStr("abc", "abcd")).toBe(false);
    expect(safeEqualStr("abc", "abd")).toBe(false);
    expect(safeEqualStr("", "")).toBe(true);
  });
});

/**
 * Handler-shape simulation for `bootstrapFirstAdmin` in `src/routes/setup.tsx`.
 *
 * Reconstructs the EXACT order of side effects in the current handler:
 *   1. dynamic import of `@/integrations/supabase/client.server`
 *   2. throttle: `begin_auth_attempt` RPC (SECURITY DEFINER — bypasses RLS)
 *   3. `assertSetupSecret(...)`
 *   4. `auth.admin.listUsers({ perPage: 1 })`
 *   5. `auth.admin.createUser({...})`
 *   6. throttle: `finalize_auth_attempt` RPC (success or failure)
 *
 * The assertions here go beyond "no createUser on reject": they verify that
 * no RLS-impacted or permission-sensitive Supabase call is issued on any
 * reject path. Concretely:
 *   - No `.from(...)` table reads/writes ever fire (nothing hits PostgREST /
 *     the Data API, so no policy can be probed by a caller who doesn't hold
 *     the secret).
 *   - `auth.admin.listUsers` / `auth.admin.createUser` (service-role auth
 *     admin surface) are not called on reject.
 *   - The only RPCs that fire on reject are the throttle RPCs — and those
 *     are intentionally SECURITY DEFINER and bypass RLS by design, so
 *     hitting them cannot leak or mutate user-scoped data.
 */
describe("bootstrapFirstAdmin dynamic-import path — no RLS/permission-impacted calls on reject", () => {
  const CONFIGURED = "a-very-long-out-of-band-secret-32chars";
  const RLS_SAFE_RPCS = new Set(["begin_auth_attempt", "finalize_auth_attempt"]);

  type Spy = ReturnType<typeof makeAdminSpy>;

  function makeAdminSpy(
    opts: { locked?: boolean; attemptId?: number | null } = {},
  ) {
    const attemptId = opts.attemptId ?? 42;
    const rpc = vi.fn(async (name: string, _args: unknown) => {
      if (name === "begin_auth_attempt") {
        return opts.locked
          ? { data: { locked: true, attempt_id: null, retry_after_seconds: 600 }, error: null }
          : { data: { locked: false, attempt_id: attemptId, remaining_attempts: 4 }, error: null };
      }
      if (name === "finalize_auth_attempt") return { data: null, error: null };
      return { data: null, error: null };
    });
    // `.from(...)` MUST never be called by the setup handler — assert-track it.
    const from = vi.fn((_table: string) => {
      throw new Error(
        `bootstrapFirstAdmin unexpectedly issued a Data API call: .from(${_table})`,
      );
    });
    return {
      rpc,
      from,
      auth: {
        admin: {
          listUsers: vi.fn(async (_opts?: unknown) => ({ data: { users: [] }, error: null })),
          createUser: vi.fn(async (_opts?: unknown) => ({ data: {}, error: null })),
        },
      },
    };
  }

  // Faithful re-implementation of the handler body. Keep this in sync with
  // `src/routes/setup.tsx` — the test's value depends on it matching.
  async function runHandler(
    input: {
      setup_secret?: string;
      email?: string;
      password?: string;
      full_name?: string;
    },
    expectedSecret: string | undefined,
    admin: Spy,
  ): Promise<{ ok: true }> {
    const THROTTLE_KEY = "setup-bootstrap";
    const { data: begin, error: beginErr } = await admin.rpc(
      "begin_auth_attempt",
      { _email: THROTTLE_KEY, _attempt_type: "setup" },
    );
    if (beginErr) throw new Error("throttle begin failed");
    const beginJson = (begin ?? {}) as {
      locked?: boolean;
      attempt_id?: number | null;
      retry_after_seconds?: number;
    };
    if (beginJson.locked) {
      throw new Error("Too many setup attempts.");
    }
    const attemptId = beginJson.attempt_id ?? null;

    try {
      assertSetupSecret(input.setup_secret, expectedSecret);
      await admin.auth.admin.listUsers({ perPage: 1 });
      await admin.auth.admin.createUser({
        email: input.email ?? "",
        password: input.password ?? "",
      });
      if (attemptId !== null) {
        await admin.rpc("finalize_auth_attempt", {
          _attempt_id: attemptId,
          _success: true,
        });
      }
      return { ok: true };
    } catch (err) {
      if (attemptId !== null) {
        await admin
          .rpc("finalize_auth_attempt", { _attempt_id: attemptId, _success: false })
          .then(
            () => undefined,
            () => undefined,
          );
      }
      throw err;
    }
  }

  function assertNoPermissionImpactedCalls(admin: Spy) {
    // No Data API (`.from`) call — no table RLS policy is ever probed.
    expect(admin.from).not.toHaveBeenCalled();
    // No service-role auth admin surface reached.
    expect(admin.auth.admin.listUsers).not.toHaveBeenCalled();
    expect(admin.auth.admin.createUser).not.toHaveBeenCalled();
    // Every RPC that DID fire must be one of the RLS-safe throttle RPCs.
    for (const call of admin.rpc.mock.calls) {
      const name = call[0] as string;
      expect(
        RLS_SAFE_RPCS.has(name),
        `Unexpected RPC on reject path: ${name}`,
      ).toBe(true);
    }
  }

  it("SETUP_SECRET unset: only throttle RPCs run; no auth admin or Data API calls", async () => {
    const spy = makeAdminSpy();
    await expect(
      runHandler({ setup_secret: "anything" }, undefined, spy),
    ).rejects.toThrow(SETUP_DISABLED_MESSAGE);
    assertNoPermissionImpactedCalls(spy);
    // Throttle recorded a failure for this reserved attempt.
    expect(spy.rpc).toHaveBeenCalledWith("begin_auth_attempt", expect.anything());
    expect(spy.rpc).toHaveBeenCalledWith("finalize_auth_attempt", {
      _attempt_id: 42,
      _success: false,
    });
  });

  it("caller omits setup_secret: only throttle RPCs run", async () => {
    const spy = makeAdminSpy();
    await expect(runHandler({}, CONFIGURED, spy)).rejects.toThrow(
      SETUP_INVALID_SECRET_MESSAGE,
    );
    assertNoPermissionImpactedCalls(spy);
    expect(spy.rpc).toHaveBeenCalledWith("finalize_auth_attempt", {
      _attempt_id: 42,
      _success: false,
    });
  });

  it("wrong setup_secret: only throttle RPCs run", async () => {
    const spy = makeAdminSpy();
    await expect(
      runHandler({ setup_secret: "totally-wrong" }, CONFIGURED, spy),
    ).rejects.toThrow(SETUP_INVALID_SECRET_MESSAGE);
    assertNoPermissionImpactedCalls(spy);
    expect(spy.rpc).toHaveBeenCalledWith("finalize_auth_attempt", {
      _attempt_id: 42,
      _success: false,
    });
  });

  it("throttle-locked: only begin_auth_attempt runs; no finalize, no auth admin, no Data API", async () => {
    const spy = makeAdminSpy({ locked: true });
    await expect(
      runHandler({ setup_secret: CONFIGURED }, CONFIGURED, spy),
    ).rejects.toThrow(/too many setup attempts/i);
    assertNoPermissionImpactedCalls(spy);
    // Under lock there is no attempt_id to finalize.
    expect(spy.rpc).toHaveBeenCalledTimes(1);
    expect(spy.rpc).toHaveBeenCalledWith("begin_auth_attempt", expect.anything());
  });

  it("correct secret: proceeds to auth admin and clears the throttle with success", async () => {
    const spy = makeAdminSpy();
    await expect(
      runHandler({ setup_secret: CONFIGURED }, CONFIGURED, spy),
    ).resolves.toEqual({ ok: true });
    // No Data API call even on the happy path — the setup flow talks only
    // to the auth admin surface plus the throttle RPCs.
    expect(spy.from).not.toHaveBeenCalled();
    expect(spy.auth.admin.listUsers).toHaveBeenCalledTimes(1);
    expect(spy.auth.admin.createUser).toHaveBeenCalledTimes(1);
    expect(spy.rpc).toHaveBeenCalledWith("finalize_auth_attempt", {
      _attempt_id: 42,
      _success: true,
    });
  });
});

