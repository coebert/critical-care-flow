// Retry helper with exponential backoff + jitter for transient network failures.
// Intended for idempotent auth calls (sign-in, getUser, getSession refresh)
// where a transient fetch failure or 5xx should not surface to the user.

export interface RetryOptions {
  retries?: number;       // total attempts = retries + 1
  baseDelayMs?: number;   // initial backoff
  maxDelayMs?: number;    // ceiling per attempt
  factor?: number;        // exponential factor
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, "shouldRetry" | "onRetry">> = {
  retries: 3,
  baseDelayMs: 250,
  maxDelayMs: 4000,
  factor: 2,
};

/**
 * Heuristic for "this looks like a transient network/server blip we should retry".
 * Covers Safari's "Load failed", fetch TypeErrors, AbortErrors, and 5xx / 408 / 429
 * shaped errors from Supabase (which expose `status` on AuthApiError).
 */
export function isTransientAuthError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; message?: string; status?: number; code?: string };
  const msg = (e.message ?? "").toLowerCase();
  if (e.name === "AbortError") return false; // user-cancelled
  if (e.name === "TypeError") return true;   // fetch failed (incl. "Load failed")
  if (msg.includes("load failed")) return true;
  if (msg.includes("network")) return true;
  if (msg.includes("failed to fetch")) return true;
  if (msg.includes("timeout") || msg.includes("timed out")) return true;
  if (typeof e.status === "number") {
    if (e.status === 408 || e.status === 429) return true;
    if (e.status >= 500 && e.status < 600) return true;
  }
  return false;
}

export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const cfg = { ...DEFAULT_OPTIONS, ...options };
  const shouldRetry = options.shouldRetry ?? isTransientAuthError;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= cfg.retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === cfg.retries || !shouldRetry(err, attempt)) throw err;
      const exp = cfg.baseDelayMs * Math.pow(cfg.factor, attempt);
      const capped = Math.min(exp, cfg.maxDelayMs);
      // Full jitter: random in [0, capped]
      const delay = Math.floor(Math.random() * capped);
      options.onRetry?.(err, attempt + 1, delay);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * Wraps a Supabase-style call that returns `{ data, error }`. If `error` looks
 * transient, retry with backoff. Otherwise return the result as-is so the
 * caller can surface the real auth error (e.g. invalid credentials).
 */
export async function retrySupabaseCall<T extends { error: unknown }>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const cfg = { ...DEFAULT_OPTIONS, ...options };
  const shouldRetry = options.shouldRetry ?? isTransientAuthError;
  let last: T | undefined;
  for (let attempt = 0; attempt <= cfg.retries; attempt++) {
    let result: T;
    try {
      result = await fn(attempt);
    } catch (err) {
      // Thrown error path — delegate to retryWithBackoff semantics
      if (attempt === cfg.retries || !shouldRetry(err, attempt)) throw err;
      const delay = Math.floor(
        Math.random() * Math.min(cfg.baseDelayMs * Math.pow(cfg.factor, attempt), cfg.maxDelayMs),
      );
      options.onRetry?.(err, attempt + 1, delay);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    last = result;
    if (!result.error) return result;
    if (attempt === cfg.retries || !shouldRetry(result.error, attempt)) return result;
    const delay = Math.floor(
      Math.random() * Math.min(cfg.baseDelayMs * Math.pow(cfg.factor, attempt), cfg.maxDelayMs),
    );
    options.onRetry?.(result.error, attempt + 1, delay);
    await new Promise((r) => setTimeout(r, delay));
  }
  return last as T;
}
