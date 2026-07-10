import { describe, it, expect, vi } from "vitest";
import {
  assertSetupSecret,
  SETUP_INVALID_SECRET_MESSAGE,
} from "./setup-secret-guard";

/**
 * End-to-end style test for the `bootstrapFirstAdmin` throttle in
 * `src/routes/setup.tsx`.
 *
 * Reconstructs the handler body (throttle-first, then guard, then auth
 * admin, then finalize) and drives it through a fake `supabaseAdmin`
 * whose `begin_auth_attempt` / `finalize_auth_attempt` RPCs faithfully
 * model the SQL contract: 5 failures / 15-minute rolling window under
 * the fixed sentinel key `"setup-bootstrap"`, after which `begin`
 * returns `locked: true` and the caller cannot even reserve an attempt.
 *
 * Assertions:
 *   - The first `LIMIT - 1` wrong-secret attempts reject with
 *     `SETUP_INVALID_SECRET_MESSAGE` and each records a failure.
 *   - The `LIMIT`th attempt still runs, records the final failure,
 *     and lockout engages immediately after.
 *   - The next attempt is rejected by the throttle BEFORE the secret
 *     guard runs — no `assertSetupSecret` code path, no auth admin
 *     surface reached.
 *   - Once locked, every subsequent attempt is also locked (no leak).
 *   - A correct secret supplied AFTER lockout is still rejected — the
 *     lock is not bypassable by finally guessing the right value.
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
  let now = Date.now();

  const advance = (ms: number) => {
    now += ms;
  };

  const rpc = vi.fn(async (name: string, args: unknown) => {
    const a = (args ?? {}) as {
      _email?: string;
      _attempt_type?: string;
      _attempt_id?: number;
      _success?: boolean;
    };
    if (name === "begin_auth_attempt") {
      // Only track our sentinel key + type.
      if (a._email !== THROTTLE_KEY || a._attempt_type !== "setup") {
        throw new Error(`unexpected throttle key: ${a._email}/${a._attempt_type}`);
      }
      const failuresInWindow = rows.filter(
        (r) => r.success === false && now - r.ts < WINDOW_MS,
      ).length;
      if (failuresInWindow >= FAILURE_LIMIT) {
        // Compute time until oldest failure ages out.
        const oldest = rows
          .filter((r) => r.success === false && now - r.ts < WINDOW_MS)
          .reduce((min, r) => Math.min(min, r.ts), Number.POSITIVE_INFINITY);
        const retry_after_seconds = Math.max(
          1,
          Math.ceil((oldest + LOCK_MS - now) / 1000),
        );
        return {
          data: { locked: true, attempt_id: null, retry_after_seconds },
          error: null,
        };
      }
      const id = nextId++;
      // Reserve as a pending failure (matches SQL: row exists until finalize).
      rows.push({ id, ts: now, success: false });
      return {
        data: {
          locked: false,
          attempt_id: id,
          remaining_attempts: FAILURE_LIMIT - failuresInWindow - 1,
        },
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

  const admin = {
    rpc,
    auth: {
      admin: {
        listUsers: vi.fn(async () => ({ data: { users: [] }, error: null })),
        createUser: vi.fn(async () => ({ data: {}, error: null })),
      },
    },
  };
  return { admin, advance, rows };
}

// Faithful re-implementation of the handler in src/routes/setup.tsx.
// Keep in sync with that file.
async function runHandler(
  input: { setup_secret?: string },
  expectedSecret: string | undefined,
  admin: ReturnType<typeof makeThrottledAdmin>["admin"],
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
    assertSetupSecret(input.setup_secret, expectedSecret);
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

describe("bootstrapFirstAdmin — brute-force lockout", () => {
  it("locks out after FAILURE_LIMIT (5) consecutive wrong-secret attempts", async () => {
    const { admin } = makeThrottledAdmin();

    // First 5 attempts: each rejects with INVALID_SECRET and burns a failure.
    for (let i = 0; i < FAILURE_LIMIT; i++) {
      await expect(
        runHandler({ setup_secret: "totally-wrong" }, CONFIGURED, admin),
      ).rejects.toThrow(SETUP_INVALID_SECRET_MESSAGE);
    }
    // Auth admin surface was reached zero times (guard rejected each).
    expect(admin.auth.admin.listUsers).not.toHaveBeenCalled();
    expect(admin.auth.admin.createUser).not.toHaveBeenCalled();

    // 6th attempt: throttle engages BEFORE the guard runs — the error is
    // the lockout error, not the invalid-secret error.
    await expect(
      runHandler({ setup_secret: "totally-wrong" }, CONFIGURED, admin),
    ).rejects.toThrow(/too many setup attempts/i);
  });

  it("stays locked for further wrong attempts (no bypass by retrying)", async () => {
    const { admin } = makeThrottledAdmin();
    for (let i = 0; i < FAILURE_LIMIT; i++) {
      await expect(
        runHandler({ setup_secret: "totally-wrong" }, CONFIGURED, admin),
      ).rejects.toThrow(SETUP_INVALID_SECRET_MESSAGE);
    }
    for (let i = 0; i < 10; i++) {
      await expect(
        runHandler({ setup_secret: "totally-wrong" }, CONFIGURED, admin),
      ).rejects.toThrow(/too many setup attempts/i);
    }
    expect(admin.auth.admin.listUsers).not.toHaveBeenCalled();
    expect(admin.auth.admin.createUser).not.toHaveBeenCalled();
  });

  it("even the correct secret is rejected while locked out", async () => {
    const { admin } = makeThrottledAdmin();
    for (let i = 0; i < FAILURE_LIMIT; i++) {
      await expect(
        runHandler({ setup_secret: "totally-wrong" }, CONFIGURED, admin),
      ).rejects.toThrow(SETUP_INVALID_SECRET_MESSAGE);
    }
    // Attacker (or legitimate operator) supplies the real secret AFTER lockout:
    // still rejected by throttle, still no auth admin call.
    await expect(
      runHandler({ setup_secret: CONFIGURED }, CONFIGURED, admin),
    ).rejects.toThrow(/too many setup attempts/i);
    expect(admin.auth.admin.listUsers).not.toHaveBeenCalled();
    expect(admin.auth.admin.createUser).not.toHaveBeenCalled();
  });

  it("attempts that fall outside the 15-minute window do not count toward lockout", async () => {
    const { admin, advance } = makeThrottledAdmin();
    // Burn 4 failures, then advance past the window.
    for (let i = 0; i < FAILURE_LIMIT - 1; i++) {
      await expect(
        runHandler({ setup_secret: "totally-wrong" }, CONFIGURED, admin),
      ).rejects.toThrow(SETUP_INVALID_SECRET_MESSAGE);
    }
    advance(WINDOW_MS + 1000);
    // Now 5 fresh failures should be needed to lock — the old ones aged out.
    for (let i = 0; i < FAILURE_LIMIT; i++) {
      await expect(
        runHandler({ setup_secret: "totally-wrong" }, CONFIGURED, admin),
      ).rejects.toThrow(SETUP_INVALID_SECRET_MESSAGE);
    }
    // The next call is the one that locks.
    await expect(
      runHandler({ setup_secret: "totally-wrong" }, CONFIGURED, admin),
    ).rejects.toThrow(/too many setup attempts/i);
  });
});
