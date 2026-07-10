import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Read the partner ICU Handover Hub's composite bed board over the signed
 * cross-project bridge. The partner exposes `/api/public/bridge/beds` which
 * returns the whole bed board in one payload (roster + occupants + stats).
 *
 * We use this instead of the per-table pull (bed_occupancies / bed_outliers /
 * bed_transfers_out) because the partner does not yet expose those three
 * endpoints — see docs/partner-bridge-handoff.md. When it does, the pg_cron
 * sync will populate the local tables and the bed board can revert to
 * getBedBoard() in beds.functions.ts.
 */

export type PartnerOccupant = {
  id: string;
  full_name: string | null;
  hospital_number: string | null;
  age: number | null;
  status: string | null;
  bed: string | null;
  admission_date: string | null;
  tep_in_place: boolean | null;
  dnacpr_decision: string | null;
  outstanding_tasks: string | null;
  updated_at: string | null;
};

export type PartnerBedSlot = {
  bed: string;
  is_side_room: boolean;
  occupied: boolean;
  occupant: PartnerOccupant | null;
};

export type PartnerBedBoardOk = {
  ok: true;
  unit: string;
  side_rooms: string[];
  bed_board: PartnerBedSlot[];
  unassigned: PartnerOccupant[];
  stats: {
    total_beds: number;
    occupied: number;
    available: number;
    unassigned: number;
  };
  fetched_at: string;
};

export type PartnerBedBoardResult =
  | PartnerBedBoardOk
  | { ok: false; error: string; fetched_at: string };

export const getPartnerBedBoard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<PartnerBedBoardResult> => {
    const fetchedAt = new Date().toISOString();
    const base = process.env.PARTNER_BRIDGE_URL;
    if (!base) {
      return { ok: false, error: "PARTNER_BRIDGE_URL is not configured", fetched_at: fetchedAt };
    }

    let secret: string;
    try {
      const { getBridgeSecrets } = await import("@/lib/bridge-hmac.server");
      secret = getBridgeSecrets().current;
    } catch (err) {
      return {
        ok: false,
        error: (err as Error).message,
        fetched_at: fetchedAt,
      };
    }

    // Partner's authorize() accepts only admin|clinician for reads. Sign as
    // the shared sync actor (admin) that is already used by the pull worker.
    const actor = JSON.stringify({
      id: "critical-care-connect-bed-board",
      email: "bed-board@critical-care-connect.local",
      role: "admin",
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const { createHmac } = await import("node:crypto");
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${actor}.`)
      .digest("hex");

    const url = `${base.replace(/\/$/, "")}/beds`;

    // Retry transient failures (network errors, 5xx, 408, 429, invalid JSON)
    // with exponential backoff + full jitter. Non-transient failures (4xx
    // other than 408/429, missing bed_board shape) return immediately.
    const MAX_ATTEMPTS = 3;
    const BASE_DELAY_MS = 250;
    const MAX_DELAY_MS = 2_000;
    const isTransientStatus = (s: number) =>
      s === 408 || s === 429 || (s >= 500 && s < 600);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    let lastError = "unknown partner error";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "GET",
          headers: {
            "x-timestamp": timestamp,
            "x-actor": actor,
            "x-signature": signature,
            "cache-control": "no-store",
          },
        });
      } catch (err) {
        lastError = `partner unreachable: ${(err as Error).message}`;
        if (attempt < MAX_ATTEMPTS) {
          const cap = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
          await sleep(Math.floor(Math.random() * cap));
          continue;
        }
        return { ok: false, error: lastError, fetched_at: fetchedAt };
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        lastError = `partner responded ${res.status}: ${body.slice(0, 200) || res.statusText}`;
        if (isTransientStatus(res.status) && attempt < MAX_ATTEMPTS) {
          const cap = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
          await sleep(Math.floor(Math.random() * cap));
          continue;
        }
        return { ok: false, error: lastError, fetched_at: fetchedAt };
      }

      let payload: unknown;
      try {
        payload = await res.json();
      } catch (err) {
        lastError = `partner returned invalid JSON: ${(err as Error).message}`;
        if (attempt < MAX_ATTEMPTS) {
          const cap = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
          await sleep(Math.floor(Math.random() * cap));
          continue;
        }
        return { ok: false, error: lastError, fetched_at: fetchedAt };
      }

      return mapPartnerPayload(payload, fetchedAt);
    }

    return { ok: false, error: lastError, fetched_at: fetchedAt };
  });

/**
 * Pure mapper for the partner `/bridge/beds` composite payload → our
 * PartnerBedBoardResult. Exported for unit tests; the server fn above calls it
 * with the raw JSON body after a successful fetch.
 */
export function mapPartnerPayload(
  payload: unknown,
  fetchedAt: string,
): PartnerBedBoardResult {
  const p = payload as Partial<PartnerBedBoardOk> | null;
  if (!p || !Array.isArray(p.bed_board)) {
    return {
      ok: false,
      error: "partner payload missing bed_board array",
      fetched_at: fetchedAt,
    };
  }
  const bedBoard = p.bed_board as PartnerBedSlot[];
  return {
    ok: true,
    unit: typeof p.unit === "string" ? p.unit : "Radnor Critical Care Unit",
    side_rooms: Array.isArray(p.side_rooms) ? p.side_rooms : [],
    bed_board: bedBoard,
    unassigned: Array.isArray(p.unassigned)
      ? (p.unassigned as PartnerOccupant[])
      : [],
    stats: p.stats ?? {
      total_beds: bedBoard.length,
      occupied: bedBoard.filter((b) => b.occupied).length,
      available: bedBoard.length - bedBoard.filter((b) => b.occupied).length,
      unassigned: 0,
    },
    fetched_at: fetchedAt,
  };
}


