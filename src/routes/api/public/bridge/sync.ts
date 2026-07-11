import { createFileRoute } from "@tanstack/react-router";
import { jsonResponse, preflight } from "@/lib/bridge-cors";
import { getBridgeSecrets, signWith } from "@/lib/bridge-hmac.server";
import { normalizeIncomingBridgeRecord } from "@/lib/bridge-normalize";

/**
 * Outbound bridge sync worker.
 *
 * Triggered by pg_cron (or manually) via POST with the project anon key
 * in the `apikey` header. For each resource:
 *   1. Pull rows updated on the partner since last_pulled_at.
 *   2. Upsert them locally via supabaseAdmin.
 *   3. Push local rows updated since last_pushed_at to the partner.
 *   4. Persist cursors + any error into bridge_sync_state.
 *
 * Runs sequentially per resource so one failure does not abort the others.
 */

type ResourceKey =
  | "patients"
  | "investigations"
  | "microbiology"
  | "referrals"
  | "beds"
  | "bed_occupancies"
  | "bed_outliers"
  | "bed_transfers_out";

// Portable column allowlists per resource. Sync pushes ONLY these keys to the
// partner so that partner-side validators (which reject unknown fields such
// as `created_by`, `updated_by`, `_enc` blobs, or internal audit metadata)
// accept the payload. Local upserts on pull still use the full row.
const PUSH_ALLOW: Record<ResourceKey, readonly string[]> = {
  patients: [
    "id",
    // NOTE: `full_name` is intentionally NOT allowlisted. Outbound push
    // never emits full names — `toPortable` renames the stored
    // (already-normalised) `full_name` value to `patient_initials` on the
    // wire so the partner only ever receives initials.
    "patient_initials",
    "hospital_number",
    "nhs_number",
    "dob",
    "location_type",
    "ward",
    "bed",
    "status",
    "admission_date",
    "discharge_date",
    "discharge_destination",
    "date_of_death",
    "past_medical_history",
    "current_admission",
    "current_management",
    "outstanding_tasks",
    "tep_in_place",
    "tep_details",
    "dnacpr_decision",
    "dnacpr_details",
    "dnacpr_date",
    "nok_name",
    "nok_relationship",
    "nok_contact",
    "nok_last_updated",
    "nok_last_updated_by",
  ],
  investigations: [
    "id",
    "patient_id",
    "category",
    "findings",
    "result_at",
  ],
  microbiology: [
    "id",
    "patient_id",
    "organism",
    "sample_type",
    "sensitivities",
    "sampled_at",
    "reported_at",
    "notes",
  ],
  referrals: [
    "id",
    "age",
    "sex",
    "current_ward",
    "current_bed",
    "dnacpr_respect",
    "referring_specialty",
    "referral_received_at",
    "first_seen_at",
    "decision_at",
    "arrived_on_unit_at",
    "status",
    "decline_reason",
    "admission_urgency",
    "consultant_to_consultant_only",
    "accepting_consultant",
    "discussed_with_consultant",
    "is_test",
    "news2_score",
    "news2_recorded_at",
    "ceiling_of_care",
    "reason_category",
    "frailty_score",
    "anticipated_interventions",
    "infection_status",
    "infection_organism",
    "weight_kg",
    "allergies",
    "resus_status",
    "previous_referral_id",
    "outcome",
    "outcome_recorded_at",
    "needs_ward_review",
    "ward_review_timeframe",
    "for_ongoing_ccot_review",
  ],
  beds: [
    "id",
    "code",
    "unit",
    "is_side_room",
    "notes",
    "active",
    "sort_order",
  ],
  bed_occupancies: [
    "id",
    "bed_id",
    "hospital_number",
    "patient_initials",
    "admitting_consultant",
    "admitted_at",
    "discharged_at",
    "level",
    "ventilated",
    "nippv_cpap",
    "hfno",
    "vasopressors",
    "renal_replacement",
    "tracheostomy",
    "isolation",
    "isolation_reason",
    "requires_side_room",
    "predicted_discharge_at",
    "predicted_step_down",
    "actual_step_down",
    "notes",
    "source_referral_id",
    "source_postop_booking_id",
    "patient_id",
    "wardable",
  ],
  bed_outliers: [
    "id",
    "hospital_number",
    "patient_initials",
    "ward",
    "admitting_consultant",
    "started_at",
    "ended_at",
    "level",
    "ventilated",
    "nippv_cpap",
    "hfno",
    "vasopressors",
    "renal_replacement",
    "reason",
    "notes",
    "deleted_at",
  ],
  bed_transfers_out: [
    "id",
    "occupancy_id",
    "kind",
    "destination_hospital",
    "destination_specialty",
    "reason",
    "transport_mode",
    "status",
    "requested_at",
    "accepted_at",
    "eta_at",
    "departed_at",
    "completed_at",
    "cancelled_at",
    "cancel_reason",
    "notes",
    "deleted_at",
  ],
};

export const RESOURCES: {
  key: ResourceKey;
  table: string;
  conflict: string;
  select: string;
}[] = [
  { key: "patients", table: "patients", conflict: "id", select: "*" },
  { key: "investigations", table: "investigations", conflict: "id", select: "*" },
  { key: "microbiology", table: "microbiology", conflict: "id", select: "*" },
  {
    // Encrypted columns cannot cross the bridge — read the safe subset plus
    // updated_at (needed for cursor bookkeeping; stripped before push).
    key: "referrals",
    table: "referrals",
    conflict: "id",
    select: [...PUSH_ALLOW.referrals, "updated_at"].join(","),
  },
  // Bed board resources — must sync in FK-safe order:
  // beds (parent) → bed_occupancies → bed_transfers_out (FK to occupancy).
  { key: "beds", table: "beds", conflict: "id", select: "*" },
  { key: "bed_occupancies", table: "bed_occupancies", conflict: "id", select: "*" },
  { key: "bed_outliers", table: "bed_outliers", conflict: "id", select: "*" },
  { key: "bed_transfers_out", table: "bed_transfers_out", conflict: "id", select: "*" },
];

export type BridgeResource = (typeof RESOURCES)[number];

export const BED_RESOURCE_KEYS: ReadonlyArray<ResourceKey> = [
  "beds",
  "bed_occupancies",
  "bed_outliers",
  "bed_transfers_out",
];

export type { ResourceKey };

export function toPortable(
  key: ResourceKey,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const allow = PUSH_ALLOW[key];
  const out: Record<string, unknown> = {};
  for (const k of allow) {
    if (k in row) out[k] = (row as any)[k];
  }
  return out;
}


const SYSTEM_ACTOR = JSON.stringify({
  id: "critical-care-connect-sync",
  email: "sync@critical-care-connect.local",
  role: "admin",
});
const PUSH_BATCH = 50;

export function signedHeaders(rawBody: string) {
  const secrets = getBridgeSecrets();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signWith(secrets.current, {
    timestamp,
    actor: SYSTEM_ACTOR,
    rawBody,
  });
  return {
    "content-type": "application/json",
    "x-timestamp": timestamp,
    "x-actor": SYSTEM_ACTOR,
    "x-signature": signature,
  };
}

export class PartnerEndpointMissingError extends Error {
  constructor(public readonly key: ResourceKey) {
    super(`partner endpoint /${key} not implemented (404) — skipped`);
    this.name = "PartnerEndpointMissingError";
  }
}

export async function pullResource(
  base: string,
  key: ResourceKey,
  since: string | null,
): Promise<Record<string, unknown>[]> {
  const url = new URL(`${base.replace(/\/$/, "")}/${key}`);
  if (since) url.searchParams.set("since", since);
  url.searchParams.set("limit", "500");
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: signedHeaders(""),
  });
  if (res.status === 404) {
    // Consume body to free the connection, then signal "not implemented".
    await res.text().catch(() => "");
    throw new PartnerEndpointMissingError(key);
  }
  if (!res.ok) {
    throw new Error(
      `pull ${key} ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  const body = (await res.json()) as { records?: Record<string, unknown>[] };
  return body.records ?? [];
}

export async function pushOne(
  base: string,
  key: ResourceKey,
  record: Record<string, unknown>,
) {
  // The partner bridge expects the row itself as the request body. Our inbound
  // receivers accept both bare rows and `{ record }`, but the partner's patient
  // and investigation validators reject the wrapped shape as an invalid payload.
  const raw = JSON.stringify(record);
  const res = await fetch(`${base.replace(/\/$/, "")}/${key}`, {
    method: "POST",
    headers: signedHeaders(raw),
    body: raw,
  });
  if (res.status === 404) {
    await res.text().catch(() => "");
    throw new PartnerEndpointMissingError(key);
  }
  if (!res.ok && res.status !== 409) {
    // 409 = partner's row is newer — acceptable, next pull will reconcile.
    throw new Error(
      `push ${key} ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
}


async function syncResource(
  admin: any,
  base: string,
  resource: (typeof RESOURCES)[number],
  source: "sync" | "retry" | "manual",
): Promise<{
  resource: ResourceKey;
  pulled: number;
  pushed: number;
  last_pulled_at: string | null;
  last_pushed_at: string | null;
  error?: string;
}> {
  const runStartedAt = new Date().toISOString();
  const startedMs = Date.now();
  const { data: state } = await admin
    .from("bridge_sync_state")
    .select("*")
    .eq("resource", resource.key)
    .maybeSingle();

  const lastPulledAt: string | null = state?.last_pulled_at ?? null;
  const lastPushedAt: string | null = state?.last_pushed_at ?? null;

  let pulled = 0;
  let pushed = 0;
  let newestPulled = lastPulledAt;
  let newestPushed = lastPushedAt;
  let error: string | undefined;

  try {
    // PULL
    const incoming = await pullResource(base, resource.key, lastPulledAt);
    if (incoming.length > 0) {
      // Normalise identifier fields BEFORE the upsert so a partner-side
      // full name never overwrites our stored initials. See
      // `normalizeIncomingBridgeRecord` for the exact rules.
      const normalised = incoming.map((r) =>
        normalizeIncomingBridgeRecord(resource.key, r),
      );
      const { error: upErr } = await admin
        .from(resource.table)
        .upsert(normalised as any, { onConflict: resource.conflict });
      if (upErr) throw new Error(`local upsert ${resource.key}: ${upErr.message}`);
      pulled = normalised.length;
      newestPulled = normalised.reduce<string | null>((acc, r) => {
        const u = (r as any).updated_at as string | undefined;
        return u && (!acc || u > acc) ? u : acc;
      }, lastPulledAt);
    }

    // PUSH
    let pushCursor = lastPushedAt;
    let page = 0;
    // Loop pages until we drain or hit a safety cap.
    while (page < 20) {
      let q = admin
        .from(resource.table)
        .select(resource.select)
        .order("updated_at", { ascending: true })
        .limit(PUSH_BATCH);
      if (pushCursor) q = q.gt("updated_at", pushCursor);
      const { data: batch, error: readErr } = await q;
      if (readErr) throw new Error(`local read ${resource.key}: ${readErr.message}`);
      if (!batch || batch.length === 0) break;
      for (const row of batch as Record<string, unknown>[]) {
        await pushOne(base, resource.key, toPortable(resource.key, row));
        pushed += 1;
        const u = (row as any).updated_at as string | undefined;
        if (u && (!pushCursor || u > pushCursor)) pushCursor = u;
      }
      newestPushed = pushCursor;
      if (batch.length < PUSH_BATCH) break;
      page += 1;
    }
  } catch (err) {
    if (err instanceof PartnerEndpointMissingError) {
      // Partner app doesn't expose this bridge endpoint yet — skip cleanly
      // instead of surfacing a red error. Cursors stay untouched so a future
      // partner rollout will pick up from where we left off.
      error = undefined;
    } else {
      error = (err as Error).message;
    }
  }


  await admin.from("bridge_sync_state").upsert(
    {
      resource: resource.key,
      last_pulled_at: newestPulled ?? lastPulledAt,
      last_pushed_at: newestPushed ?? lastPushedAt,
      last_error: error ?? null,
      last_error_at: error ? runStartedAt : null,
    },
    { onConflict: "resource" },
  );

  // Record this attempt in the audit log for admin visibility.
  // Fire-and-forget: audit failures must not break the sync itself.
  await admin.from("bridge_sync_attempts").insert({
    source,
    resource: resource.key,
    ok: !error,
    pulled,
    pushed,
    duration_ms: Date.now() - startedMs,
    error: error ?? null,
  }).then(() => {}, () => {});

  return {
    resource: resource.key,
    pulled,
    pushed,
    last_pulled_at: newestPulled,
    last_pushed_at: newestPushed,
    error,
  };
}

// Exported so the retry-failed route (and admin manual runs) can reuse
// the same auth + sync pipeline without duplicating it.
export async function runBridgeSync(
  request: Request,
  opts: {
    failedOnly?: boolean;
    bedsOnly?: boolean;
    source?: "sync" | "retry" | "manual";
  } = {},
): Promise<Response> {
  const source = opts.source ?? "sync";
  const failedOnly = Boolean(opts.failedOnly);
  const bedsOnly = Boolean(opts.bedsOnly);

  const apiKey = request.headers.get("apikey") ?? "";
  const allowed = [
    process.env.SUPABASE_PUBLISHABLE_KEY,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  ].filter(Boolean) as string[];
  if (!allowed.includes(apiKey)) {
    return jsonResponse({ error: "unauthorized" }, { status: 401 });
  }

  const partner = process.env.PARTNER_BRIDGE_URL;
  if (!partner) {
    return jsonResponse(
      { error: "PARTNER_BRIDGE_URL_not_configured" },
      { status: 500 },
    );
  }

  try {
    getBridgeSecrets();
  } catch (err) {
    return jsonResponse(
      { error: (err as Error).message },
      { status: 500 },
    );
  }

  const { supabaseAdmin } = await import(
    "@/integrations/supabase/client.server"
  );

  // Determine which resources to run. Retry mode skips resources that are
  // currently healthy so we don't hammer the partner needlessly. Beds mode
  // restricts to bed-related tables (also FK-safe because RESOURCES is
  // already declared in bed-safe order).
  let toRun = RESOURCES;
  if (bedsOnly) {
    toRun = RESOURCES.filter((r) => BED_RESOURCE_KEYS.includes(r.key));
  }
  if (failedOnly) {
    const { data: state } = await supabaseAdmin
      .from("bridge_sync_state")
      .select("resource,last_error");
    const failedKeys = new Set(
      (state ?? [])
        .filter((r: any) => r.last_error != null)
        .map((r: any) => r.resource as string),
    );
    toRun = toRun.filter((r) => failedKeys.has(r.key));
    if (toRun.length === 0) {
      return jsonResponse({
        ok: true,
        skipped: true,
        reason: "no_failed_resources",
        partner,
        ran_at: new Date().toISOString(),
        results: [],
      });
    }
  }

  const results: Awaited<ReturnType<typeof syncResource>>[] = [];
  for (const r of toRun) {
    // Sequential; per-resource failure is captured and does not abort others.
    // eslint-disable-next-line no-await-in-loop
    const summary = await syncResource(supabaseAdmin, partner, r, source);
    results.push(summary);
  }

  const hadError = results.some((r) => r.error);
  return jsonResponse(
    {
      ok: !hadError,
      partner,
      source,
      ran_at: new Date().toISOString(),
      results,
    },
    { status: hadError ? 207 : 200 },
  );
}

export const Route = createFileRoute("/api/public/bridge/sync")({
  server: {
    handlers: {
      OPTIONS: async () => preflight(),

      // Cron trigger. Also accepts GET for manual introspection.
      GET: async ({ request }) => runBridgeSync(request, { source: "sync" }),
      POST: async ({ request }) => runBridgeSync(request, { source: "sync" }),
    },
  },
});
