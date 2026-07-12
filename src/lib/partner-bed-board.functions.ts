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
  dnacpr_decision: boolean | null;
  dnacpr_details?: string | null;
  tep_details?: string | null;

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
  | {
      ok: false;
      error: string;
      fetched_at: string;
      partner_outage?: boolean;
      status?: number;
    };

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

    const { classifyPartnerHttpFailure, classifyPartnerNetworkFailure } =
      await import("@/lib/partner-outage");

    let lastError = "unknown partner error";
    let lastOutage = false;
    let lastStatus: number | undefined;
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
        const cls = classifyPartnerNetworkFailure(err);
        lastError = cls.message;
        lastOutage = cls.is_outage;
        lastStatus = 0;
        if (attempt < MAX_ATTEMPTS) {
          const cap = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
          await sleep(Math.floor(Math.random() * cap));
          continue;
        }
        return {
          ok: false,
          error: lastError,
          fetched_at: fetchedAt,
          partner_outage: lastOutage,
          status: lastStatus,
        };
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const cls = classifyPartnerHttpFailure(res.status, body);
        lastError = cls.message;
        lastOutage = cls.is_outage;
        lastStatus = res.status;
        if (isTransientStatus(res.status) && attempt < MAX_ATTEMPTS) {
          const cap = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
          await sleep(Math.floor(Math.random() * cap));
          continue;
        }
        return {
          ok: false,
          error: lastError,
          fetched_at: fetchedAt,
          partner_outage: lastOutage,
          status: lastStatus,
        };
      }

      let payload: unknown;
      try {
        payload = await res.json();
      } catch (err) {
        lastError = `partner returned invalid JSON: ${(err as Error).message}`;
        lastOutage = false;
        lastStatus = res.status;
        if (attempt < MAX_ATTEMPTS) {
          const cap = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
          await sleep(Math.floor(Math.random() * cap));
          continue;
        }
        return {
          ok: false,
          error: lastError,
          fetched_at: fetchedAt,
          partner_outage: lastOutage,
          status: lastStatus,
        };
      }

      return mapPartnerPayload(payload, fetchedAt);
    }

    return {
      ok: false,
      error: lastError,
      fetched_at: fetchedAt,
      partner_outage: lastOutage,
      status: lastStatus,
    };
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

// ============================================================================
// Write path — edit a patient on the partner via POST /bridge/patients.
// The partner's authorize() accepts admin or clinician as write roles; we
// require has_clinical_access on our side and forward the signed-in user's
// identity as the actor in the HMAC envelope.
// ============================================================================

export type UpdatePartnerPatientInput = {
  id: string;
  expected_updated_at: string | null;
  full_name?: string | null;
  hospital_number?: string | null;
  age?: number | null;
  bed?: string | null;
  status?: "referred" | "admitted" | "discharged" | "died";
  tep_in_place?: boolean;
  tep_details?: string | null;
  dnacpr_decision?: boolean;
  dnacpr_details?: string | null;
  outstanding_tasks?: string | null;
  // Extended handover fields — used by the referral-prefill flow to seed the
  // partner handover form when a referred patient is first admitted. Kept
  // optional so nothing changes for callers that only edit the basic set.
  past_medical_history?: string | null;
  current_admission?: string | null;
  current_management?: string | null;
};

export type UpdatePartnerPatientResult =
  | { ok: true; patient: PartnerOccupant }
  | {
      ok: false;
      error: string;
      status?: number;
      conflict?: {
        current: PartnerOccupant;
        your_expected_updated_at: string | null;
      };
    };

export const updatePartnerPatient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: UpdatePartnerPatientInput) => {
    if (!data || typeof data !== "object" || typeof data.id !== "string" || !data.id) {
      throw new Error("id is required");
    }
    const normStr = (v: unknown) =>
      v === undefined
        ? undefined
        : v === null || (typeof v === "string" && v.trim() === "")
          ? null
          : String(v);
    const age =
      data.age === undefined
        ? undefined
        : data.age === null || (typeof data.age === "string" && data.age === "")
          ? null
          : Number(data.age);
    if (age !== undefined && age !== null && (!Number.isFinite(age) || age < 0 || age > 130)) {
      throw new Error("age must be between 0 and 130");
    }
    if (
      data.status !== undefined &&
      !["referred", "admitted", "discharged", "died"].includes(data.status)
    ) {
      throw new Error("invalid status");
    }
    return {
      id: data.id,
      expected_updated_at: data.expected_updated_at ?? null,
      full_name: normStr(data.full_name),
      hospital_number: normStr(data.hospital_number),
      age,
      bed: normStr(data.bed),
      status: data.status,
      tep_in_place: typeof data.tep_in_place === "boolean" ? data.tep_in_place : undefined,
      tep_details: normStr(data.tep_details),
      dnacpr_decision:
        typeof data.dnacpr_decision === "boolean" ? data.dnacpr_decision : undefined,
      dnacpr_details: normStr(data.dnacpr_details),
      outstanding_tasks: normStr(data.outstanding_tasks),
      past_medical_history: normStr(data.past_medical_history),
      current_admission: normStr(data.current_admission),
      current_management: normStr(data.current_management),
    } satisfies UpdatePartnerPatientInput;
  })
  .handler(async ({ data, context }): Promise<UpdatePartnerPatientResult> => {
    const base = process.env.PARTNER_BRIDGE_URL;
    if (!base) return { ok: false, error: "PARTNER_BRIDGE_URL is not configured" };

    // Only clinicians/admins on our side may write across the bridge.
    const { data: allowed, error: roleErr } = await context.supabase.rpc(
      "has_clinical_access",
      { _user_id: context.userId },
    );
    if (roleErr) return { ok: false, error: `authz check failed: ${roleErr.message}` };
    if (!allowed) return { ok: false, error: "forbidden: clinical role required", status: 403 };

    let secret: string;
    try {
      const { getBridgeSecrets } = await import("@/lib/bridge-hmac.server");
      secret = getBridgeSecrets().current;
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }

    // Forward the caller's identity as the actor. Partner authorize() treats
    // the actor as authentic because it is inside the HMAC envelope.
    const claims = context.claims as Record<string, unknown>;
    const email = typeof claims.email === "string" ? claims.email : undefined;
    const actor = JSON.stringify({ id: context.userId, email, role: "clinician" });

    const bodyObj: Record<string, unknown> = { id: data.id };
    if (data.expected_updated_at) bodyObj.expected_updated_at = data.expected_updated_at;
    for (const key of [
      "full_name",
      "hospital_number",
      "age",
      "bed",
      "status",
      "tep_in_place",
      "tep_details",
      "dnacpr_decision",
      "dnacpr_details",
      "outstanding_tasks",
      "past_medical_history",
      "current_admission",
      "current_management",
    ] as const) {
      const v = (data as Record<string, unknown>)[key];
      if (v !== undefined) bodyObj[key] = v;
    }
    const rawBody = JSON.stringify(bodyObj);

    const timestamp = String(Math.floor(Date.now() / 1000));
    const { createHmac } = await import("node:crypto");
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${actor}.${rawBody}`)
      .digest("hex");

    const url = `${base.replace(/\/$/, "")}/patients`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-timestamp": timestamp,
          "x-actor": actor,
          "x-signature": signature,
          "cache-control": "no-store",
        },
        body: rawBody,
      });
    } catch (err) {
      return { ok: false, error: `partner unreachable: ${(err as Error).message}` };
    }

    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      /* keep null */
    }

    if (res.status === 409) {
      const p = (payload ?? {}) as {
        current?: PartnerOccupant;
        your_expected_updated_at?: string | null;
        message?: string;
      };
      return {
        ok: false,
        status: 409,
        error: p.message ?? "This patient was modified since you loaded it.",
        conflict: p.current
          ? {
              current: p.current,
              your_expected_updated_at: p.your_expected_updated_at ?? null,
            }
          : undefined,
      };
    }

    if (!res.ok) {
      const msg =
        (payload as { error?: string; message?: string } | null)?.error ||
        (payload as { error?: string; message?: string } | null)?.message ||
        res.statusText;
      return { ok: false, status: res.status, error: `partner ${res.status}: ${msg}` };
    }

    const p = payload as { patient?: PartnerOccupant } | null;
    if (!p?.patient) {
      return { ok: false, error: "partner returned no patient row" };
    }
    return { ok: true, patient: p.patient };
  });



