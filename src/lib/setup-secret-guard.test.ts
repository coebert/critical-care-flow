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
 * Handler-shape simulation: reconstructs the exact order used by
 * `bootstrapFirstAdmin` (guard first, then dynamically import a Supabase
 * admin client and call it) and asserts the admin client is NEVER reached
 * on any reject path.
 */
describe("bootstrapFirstAdmin handler order — no DB writes on reject", () => {
  async function runHandler(
    input: { setup_secret?: string },
    expected: string | undefined,
    supabaseAdminMock: {
      auth: { admin: { listUsers: () => unknown; createUser: () => unknown } };
    },
  ): Promise<{ ok: true }> {
    assertSetupSecret(input.setup_secret, expected);
    // If the guard passed, the handler proceeds to touch the admin client.
    await supabaseAdminMock.auth.admin.listUsers();
    await supabaseAdminMock.auth.admin.createUser();
    return { ok: true };
  }

  function makeAdminSpy() {
    return {
      auth: {
        admin: {
          listUsers: vi.fn(async () => ({ data: { users: [] }, error: null })),
          createUser: vi.fn(async () => ({ data: {}, error: null })),
        },
      },
    };
  }

  const CONFIGURED = "a-very-long-out-of-band-secret-32chars";

  it("does not call listUsers or createUser when SETUP_SECRET is unset", async () => {
    const spy = makeAdminSpy();
    await expect(
      runHandler({ setup_secret: "anything" }, undefined, spy),
    ).rejects.toThrow(SETUP_DISABLED_MESSAGE);
    expect(spy.auth.admin.listUsers).not.toHaveBeenCalled();
    expect(spy.auth.admin.createUser).not.toHaveBeenCalled();
  });

  it("does not call listUsers or createUser when the caller omits the secret", async () => {
    const spy = makeAdminSpy();
    await expect(runHandler({}, CONFIGURED, spy)).rejects.toThrow(
      SETUP_INVALID_SECRET_MESSAGE,
    );
    expect(spy.auth.admin.listUsers).not.toHaveBeenCalled();
    expect(spy.auth.admin.createUser).not.toHaveBeenCalled();
  });

  it("does not call listUsers or createUser when the secret is wrong", async () => {
    const spy = makeAdminSpy();
    await expect(
      runHandler({ setup_secret: "totally-wrong" }, CONFIGURED, spy),
    ).rejects.toThrow(SETUP_INVALID_SECRET_MESSAGE);
    expect(spy.auth.admin.listUsers).not.toHaveBeenCalled();
    expect(spy.auth.admin.createUser).not.toHaveBeenCalled();
  });

  it("proceeds to the admin client only when the secret matches exactly", async () => {
    const spy = makeAdminSpy();
    await expect(
      runHandler({ setup_secret: CONFIGURED }, CONFIGURED, spy),
    ).resolves.toEqual({ ok: true });
    expect(spy.auth.admin.listUsers).toHaveBeenCalledTimes(1);
    expect(spy.auth.admin.createUser).toHaveBeenCalledTimes(1);
  });
});
