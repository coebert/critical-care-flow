import { describe, it, expect, vi } from "vitest";
import {
  assertSetupSecret,
  SETUP_DISABLED_MESSAGE,
  SETUP_INVALID_SECRET_MESSAGE,
} from "./setup-secret-guard";

/**
 * Non-disclosure test for the `/setup` lockout response.
 *
 * Once `bootstrapFirstAdmin` is locked out by the throttle, the error
 * returned to the caller MUST be indistinguishable across every possible
 * input classification: correct secret, wrong secret, empty string,
 * omitted field, null, whitespace, wrong type. Otherwise an attacker can
 * probe whether their guess landed close, or infer that the server is
 * mid-configured, purely from the response text/shape.
 *
 * This spec fixes the following non-leak invariants for the locked path:
 *   1. The error message is byte-for-byte identical across all inputs
 *      (only the minutes value depends on time, which is frozen here).
 *   2. The message matches the exact template used by `setup.tsx` and
 *      contains none of these substrings (case-insensitive):
 *        "secret", "invalid", "wrong", "missing", "empty", "required",
 *        "disabled", "unset", "configured", "match", the SETUP_*_MESSAGE
 *        strings, or the literal secret value.
 *   3. The thrown value is a plain `Error` with no extra enumerable
 *      properties (no `code`, `reason`, `input`, `cause` metadata).
 *   4. No calls to `assertSetupSecret`, `listUsers`, or `createUser`
 *      happen once locked — so nothing downstream can differ between
 *      inputs either.
 */

const CONFIGURED = "a-very-long-out-of-band-secret-32chars";
const THROTTLE_KEY = "setup-bootstrap";
const FAILURE_LIMIT = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

type AttemptRow = { id: number; ts: number; success: boolean | null };

function makeThrottledAdmin() {
  const rows: AttemptRow[] = [];
  let nextId = 1;
  const now = { t: 1_700_000_000_000 }; // frozen wall clock so retry_after is stable

  const rpc = vi.fn(async (name: string, args: unknown) => {
    const a = (args ?? {}) as {
      _email?: string;
      _attempt_type?: string;
      _attempt_id?: number;
      _success?: boolean;
    };
    if (name === "begin_auth_attempt") {
      if (a._email !== THROTTLE_KEY || a._attempt_type !== "setup") {
        throw new Error(`unexpected throttle key: ${a._email}/${a._attempt_type}`);
      }
      const failuresInWindow = rows.filter(
        (r) => r.success === false && now.t - r.ts < WINDOW_MS,
      ).length;
      if (failuresInWindow >= FAILURE_LIMIT) {
        const oldest = rows
          .filter((r) => r.success === false && now.t - r.ts < WINDOW_MS)
          .reduce((min, r) => Math.min(min, r.ts), Number.POSITIVE_INFINITY);
        const retry_after_seconds = Math.max(
          1,
          Math.ceil((oldest + LOCK_MS - now.t) / 1000),
        );
        return {
          data: { locked: true, attempt_id: null, retry_after_seconds },
          error: null,
        };
      }
      const id = nextId++;
      rows.push({ id, ts: now.t, success: false });
      return {
        data: { locked: false, attempt_id: id },
        error: null,
      };
    }
    if (name === "finalize_auth_attempt") {
      const row = rows.find((r) => r.id === a._attempt_id);
      if (row) row.success = !!a._success;
      return { data: null, error: null };
    }
    return { data: null, error: null };
  });

  // Wrap the guard so we can count invocations from the locked run.
  const guardSpy = vi.fn(assertSetupSecret);

  const admin = {
    rpc,
    auth: {
      admin: {
        listUsers: vi.fn(async (_opts?: unknown) => ({ data: { users: [] }, error: null })),
        createUser: vi.fn(async (_opts?: unknown) => ({ data: {}, error: null })),
      },
    },
  };
  return { admin, guardSpy };
}

// Handler shape mirrored from src/routes/setup.tsx. Keep in sync.
async function runHandler(
  input: Record<string, unknown>,
  expectedSecret: string | undefined,
  admin: ReturnType<typeof makeThrottledAdmin>["admin"],
  guardSpy: ReturnType<typeof makeThrottledAdmin>["guardSpy"],
): Promise<{ ok: true }> {
  const { data: begin } = await admin.rpc("begin_auth_attempt", {
    _email: THROTTLE_KEY,
    _attempt_type: "setup",
  });
  const b = (begin ?? {}) as {
    locked?: boolean;
    attempt_id?: number | null;
    retry_after_seconds?: number;
  };
  if (b.locked) {
    const mins = Math.max(1, Math.ceil((b.retry_after_seconds ?? 900) / 60));
    throw new Error(
      `Too many setup attempts. Try again in about ${mins} minute${mins === 1 ? "" : "s"}.`,
    );
  }
  const attemptId = b.attempt_id ?? null;
  try {
    guardSpy(
      (input as { setup_secret?: unknown }).setup_secret as string | undefined,
      expectedSecret,
    );
    await admin.auth.admin.listUsers({ perPage: 1 });
    await admin.auth.admin.createUser({ email: "", password: "" });
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
        .then(() => undefined, () => undefined);
    }
    throw err;
  }
}

// The exact template setup.tsx throws when begin returns locked=true.
const LOCKOUT_REGEX =
  /^Too many setup attempts\. Try again in about \d+ minutes?\.$/;

// Words / phrases the locked response must never contain, in any casing.
// These would let a caller distinguish "wrong secret" vs "missing secret"
// vs "server not configured" vs "guess was close".
const FORBIDDEN_SUBSTRINGS = [
  "secret",
  "invalid",
  "wrong",
  "incorrect",
  "missing",
  "empty",
  "required",
  "disabled",
  "unset",
  "not configured",
  "match",
  "provided",
  "expected",
  SETUP_INVALID_SECRET_MESSAGE.toLowerCase(),
  SETUP_DISABLED_MESSAGE.toLowerCase(),
];

describe("bootstrapFirstAdmin — locked response reveals nothing about the input", () => {
  it("returns the identical error for every input classification once locked", async () => {
    const { admin, guardSpy } = makeThrottledAdmin();

    // Prime the throttle to the lockout threshold with wrong guesses.
    for (let i = 0; i < FAILURE_LIMIT; i++) {
      await expect(
        runHandler({ setup_secret: "totally-wrong" }, CONFIGURED, admin, guardSpy),
      ).rejects.toThrow(SETUP_INVALID_SECRET_MESSAGE);
    }
    // Reset spies so we measure ONLY the locked run below.
    guardSpy.mockClear();
    admin.auth.admin.listUsers.mockClear();
    admin.auth.admin.createUser.mockClear();

    // Every one of these inputs must produce the SAME locked-out error.
    const inputs: { label: string; input: Record<string, unknown> }[] = [
      { label: "correct secret", input: { setup_secret: CONFIGURED } },
      { label: "wrong secret", input: { setup_secret: "totally-wrong" } },
      { label: "one-char-off secret", input: { setup_secret: CONFIGURED.slice(0, -1) + "X" } },
      { label: "empty string", input: { setup_secret: "" } },
      { label: "whitespace only", input: { setup_secret: "   " } },
      { label: "field omitted", input: {} },
      { label: "explicit null", input: { setup_secret: null } },
      { label: "explicit undefined", input: { setup_secret: undefined } },
      { label: "wrong type: number", input: { setup_secret: 12345 } },
      { label: "wrong type: object", input: { setup_secret: { toString: () => CONFIGURED } } },
      { label: "wrong type: array", input: { setup_secret: [CONFIGURED] } },
    ];

    const messages: { label: string; msg: string }[] = [];
    for (const { label, input } of inputs) {
      let err: unknown;
      try {
        await runHandler(input, CONFIGURED, admin, guardSpy);
      } catch (e) {
        err = e;
      }

      // 3. Thrown value shape: plain Error, no extra metadata that could
      //    leak the branch that fired.
      expect(err, `${label}: expected an Error`).toBeInstanceOf(Error);
      const e = err as Error;
      expect(e.name).toBe("Error");
      // No extra enumerable properties beyond what Error normally has.
      const extras = Object.keys(e).filter(
        (k) => k !== "message" && k !== "stack",
      );
      expect(extras, `${label}: unexpected props ${extras.join(",")}`).toEqual([]);
      // No `cause` chain that could carry the classification.
      expect((e as { cause?: unknown }).cause).toBeUndefined();

      const msg = e.message;
      // 2a. Message matches the exact locked template.
      expect(msg, `${label}: shape mismatch — ${msg}`).toMatch(LOCKOUT_REGEX);
      // 2b. Message contains none of the forbidden substrings.
      const lower = msg.toLowerCase();
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        expect(lower.includes(forbidden), `${label}: leaks "${forbidden}" → ${msg}`).toBe(false);
      }
      // 2c. Never echoes the literal secret value.
      expect(msg.includes(CONFIGURED), `${label}: echoes secret`).toBe(false);

      messages.push({ label, msg });
    }

    // 1. Byte-for-byte identical across every classification. With the
    //    fake clock frozen, the minutes value is stable, so any variation
    //    would be a real information leak.
    const distinct = new Set(messages.map((m) => m.msg));
    expect(
      distinct.size,
      `locked response varied across inputs: ${JSON.stringify([...distinct])}`,
    ).toBe(1);

    // 4. Nothing downstream ran that could differ between inputs.
    expect(guardSpy).not.toHaveBeenCalled();
    expect(admin.auth.admin.listUsers).not.toHaveBeenCalled();
    expect(admin.auth.admin.createUser).not.toHaveBeenCalled();
  });

  it("locked response is also identical when SETUP_SECRET is unset on the server", async () => {
    // A server without SETUP_SECRET would normally throw
    // SETUP_DISABLED_MESSAGE via the guard. If we're locked, the caller
    // must not be able to tell the server-config state apart from the
    // wrong-guess state — the throttle short-circuits either way.
    const { admin, guardSpy } = makeThrottledAdmin();

    // Prime the throttle with CONFIGURED as the "expected" so we can lock it.
    for (let i = 0; i < FAILURE_LIMIT; i++) {
      await expect(
        runHandler({ setup_secret: "wrong" }, CONFIGURED, admin, guardSpy),
      ).rejects.toThrow(SETUP_INVALID_SECRET_MESSAGE);
    }
    guardSpy.mockClear();

    // Now hit the locked endpoint as if the server has NO configured secret.
    let unsetErr: unknown;
    try {
      await runHandler({ setup_secret: "anything" }, undefined, admin, guardSpy);
    } catch (e) {
      unsetErr = e;
    }
    // ...and again as if the configured secret is too short to be valid.
    let shortErr: unknown;
    try {
      await runHandler({ setup_secret: "anything" }, "short", admin, guardSpy);
    } catch (e) {
      shortErr = e;
    }
    // ...and once with the correct secret.
    let okErr: unknown;
    try {
      await runHandler({ setup_secret: CONFIGURED }, CONFIGURED, admin, guardSpy);
    } catch (e) {
      okErr = e;
    }

    for (const err of [unsetErr, shortErr, okErr]) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(LOCKOUT_REGEX);
    }
    // All three responses are byte-identical: the caller cannot infer
    // whether the server is "disabled" (unset / short) or just "locked".
    expect(
      new Set([
        (unsetErr as Error).message,
        (shortErr as Error).message,
        (okErr as Error).message,
      ]).size,
    ).toBe(1);

    // Guard never ran — so the disabled/invalid branches couldn't fire.
    expect(guardSpy).not.toHaveBeenCalled();
    expect(admin.auth.admin.listUsers).not.toHaveBeenCalled();
    expect(admin.auth.admin.createUser).not.toHaveBeenCalled();
  });
});
