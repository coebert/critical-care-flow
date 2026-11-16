// Server-only: signed read of the ICU Handover Hub composite bed board, and
// the role guard that must pass BEFORE any signed request is made on behalf
// of a signed-in user.

import { createHmac } from "node:crypto";
import {
  mapPartnerPayload,
  type PartnerBedBoardFailure,
  type PartnerBedBoardResult,
} from "./partner-bed-board-contract";
import { classifyPartnerHttpFailure, classifyPartnerNetworkFailure } from "./partner-outage";
import { HUB_TIMEOUT_MS } from "./hub-client.server";

export type BoardAccessContext = {
  userId: string;
  supabase: {
    rpc: (
      fn: "has_clinical_access",
      args: { _user_id: string },
    ) => PromiseLike<{ data: unknown; error: unknown }>;
  };
};

/**
 * Who may read the signed partner board: exactly the existing clinical
 * predicate `public.has_clinical_access(uuid)` (roles admin | clinician) —
 * the same gate used by every referral / patient-flag RLS policy. The TV
 * board and Bed Board are used by these roles; there is no separate
 * kiosk/viewer role in `app_role`. Any error denies.
 */
export async function checkBoardAccess(
  context: BoardAccessContext,
): Promise<{ ok: true } | PartnerBedBoardFailure> {
  const fetched_at = new Date().toISOString();
  try {
    if (!context?.userId) {
      return { ok: false, error: "Not signed in", status: 401, forbidden: true, fetched_at };
    }
    const { data, error } = await context.supabase.rpc("has_clinical_access", {
      _user_id: context.userId,
    });
    if (error) {
      console.error("[partner-bed-board] access check failed", error);
      return { ok: false, error: "Permission check failed", status: 503, forbidden: true, fetched_at };
    }
    if (data !== true) {
      return {
        ok: false,
        error: "Your account does not have bed board access (clinical role required)",
        status: 403,
        forbidden: true,
        fetched_at,
      };
    }
    return { ok: true };
  } catch (e) {
    console.error("[partner-bed-board] access check threw", e);
    return { ok: false, error: "Permission check failed", status: 503, forbidden: true, fetched_at };
  }
}

export type PartnerFetchDeps = {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  secret?: string;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  /** Per-attempt timeout; defaults to HUB_TIMEOUT_MS. */
  timeoutMs?: number;
};

/**
 * Signed GET {PARTNER_BRIDGE_URL}/beds with bounded retry of transient
 * failures. Always resolves to a validated PartnerBedBoardResult.
 */
export async function fetchPartnerBedBoardSigned(
  deps: PartnerFetchDeps = {},
): Promise<PartnerBedBoardResult> {
  const fetchedAt = new Date().toISOString();
  const base = deps.baseUrl ?? process.env.PARTNER_BRIDGE_URL;
  if (!base) {
    return { ok: false, error: "PARTNER_BRIDGE_URL is not configured", fetched_at: fetchedAt };
  }
  let secret = deps.secret;
  if (!secret) {
    try {
      const { getBridgeSecrets } = await import("./bridge-hmac.server");
      secret = getBridgeSecrets().current;
    } catch (err) {
      return { ok: false, error: (err as Error).message, fetched_at: fetchedAt };
    }
  }
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  // Partner authorize() accepts only admin|clinician for reads. Sign as the
  // shared sync actor; the caller's own role was checked before we got here.
  const actor = JSON.stringify({
    id: "critical-care-connect-bed-board",
    email: "bed-board@critical-care-connect.local",
    role: "admin",
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret).update(`${timestamp}.${actor}.`).digest("hex");
  const url = `${base.replace(/\/$/, "")}/beds`;

  const MAX_ATTEMPTS = deps.maxAttempts ?? 3;
  const BASE_DELAY_MS = 250;
  const MAX_DELAY_MS = 2_000;
  const isTransientStatus = (s: number) => s === 408 || s === 429 || (s >= 500 && s < 600);
  const backoff = (attempt: number) =>
    sleep(Math.floor(Math.random() * Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS)));

  let last: PartnerBedBoardFailure = { ok: false, error: "unknown partner error", fetched_at: fetchedAt };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    const controller = new AbortController();
    const timeoutMs = deps.timeoutMs ?? HUB_TIMEOUT_MS;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      res = await doFetch(url, {
        method: "GET",
        headers: {
          "x-timestamp": timestamp,
          "x-actor": actor,
          "x-signature": signature,
          "cache-control": "no-store",
        },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const cls = timedOut
        ? { message: `ICU Handover Hub did not respond within ${Math.round(timeoutMs / 1000)}s`, is_outage: true }
        : classifyPartnerNetworkFailure(err);
      last = { ok: false, error: cls.message, fetched_at: fetchedAt, partner_outage: cls.is_outage, status: 0 };
      if (attempt < MAX_ATTEMPTS) {
        await backoff(attempt);
        continue;
      }
      return last;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      clearTimeout(timer);
      const cls = classifyPartnerHttpFailure(res.status, body);
      // The Hub answers an ambiguous roster with an HTTP error carrying
      // `indeterminate: true` rather than a misleading successful count.
      let indeterminate = false;
      try {
        const j = JSON.parse(body) as { indeterminate?: unknown; stats?: { indeterminate?: unknown } };
        indeterminate = j?.indeterminate === true || j?.stats?.indeterminate === true;
      } catch {
        /* not JSON */
      }
      last = {
        ok: false,
        error: indeterminate ? "ICU Handover Hub could not confirm bed occupancy (indeterminate roster)" : cls.message,
        fetched_at: fetchedAt,
        partner_outage: indeterminate ? false : cls.is_outage,
        status: res.status,
        ...(indeterminate ? { indeterminate: true } : {}),
      };
      if (isTransientStatus(res.status) && attempt < MAX_ATTEMPTS) {
        await backoff(attempt);
        continue;
      }
      return last;
    }

    let payload: unknown;
    try {
      payload = await res.json();
      clearTimeout(timer);
    } catch (err) {
      clearTimeout(timer);
      last = {
        ok: false,
        error: timedOut ? "ICU Handover Hub response timed out" : `partner returned invalid JSON: ${(err as Error).message}`,
        fetched_at: fetchedAt,
        partner_outage: false,
        status: res.status,
      };
      if (attempt < MAX_ATTEMPTS) {
        await backoff(attempt);
        continue;
      }
      return last;
    }
    return mapPartnerPayload(payload, fetchedAt);
  }
  return last;
}

/** Role guard first; the signed request is only built after it passes. */
export async function loadPartnerBedBoardForCaller(
  context: BoardAccessContext,
  deps: PartnerFetchDeps = {},
): Promise<PartnerBedBoardResult> {
  const access = await checkBoardAccess(context);
  if (!access.ok) return access;
  return fetchPartnerBedBoardSigned(deps);
}
