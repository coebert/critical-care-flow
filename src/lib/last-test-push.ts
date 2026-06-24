// Tiny client-side store for the timestamp of the last successful test push.
// Kept in localStorage so it's per-device — matching the per-device nature of
// push subscriptions themselves. No PII is stored.

const KEY = "push:last-test-success-at";

export function recordTestPushSuccess(at: Date = new Date()): void {
  try {
    localStorage.setItem(KEY, at.toISOString());
  } catch {
    // ignore (private mode / disabled storage)
  }
}

export function readLastTestPushAt(): Date | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}
