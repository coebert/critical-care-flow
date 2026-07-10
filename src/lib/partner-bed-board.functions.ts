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
      return {
        ok: false,
        error: `partner unreachable: ${(err as Error).message}`,
        fetched_at: fetchedAt,
      };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        error: `partner responded ${res.status}: ${body.slice(0, 200) || res.statusText}`,
        fetched_at: fetchedAt,
      };
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch (err) {
      return {
        ok: false,
        error: `partner returned invalid JSON: ${(err as Error).message}`,
        fetched_at: fetchedAt,
      };
    }

    const p = payload as Partial<PartnerBedBoardOk> | null;
    if (!p || !Array.isArray(p.bed_board)) {
      return {
        ok: false,
        error: "partner payload missing bed_board array",
        fetched_at: fetchedAt,
      };
    }

    return {
      ok: true,
      unit: typeof p.unit === "string" ? p.unit : "Radnor Critical Care Unit",
      side_rooms: Array.isArray(p.side_rooms) ? p.side_rooms : [],
      bed_board: p.bed_board as PartnerBedSlot[],
      unassigned: Array.isArray(p.unassigned) ? (p.unassigned as PartnerOccupant[]) : [],
      stats: p.stats ?? {
        total_beds: p.bed_board.length,
        occupied: p.bed_board.filter((b) => b.occupied).length,
        available:
          p.bed_board.length - p.bed_board.filter((b) => b.occupied).length,
        unassigned: 0,
      },
      fetched_at: fetchedAt,
    };
  });
