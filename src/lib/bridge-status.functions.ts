import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertAdmin } from "@/lib/auth-guards";

export type BridgeResourceStatus = {
  resource: string;
  row_count: number;
  last_pulled_at: string | null;
  last_pushed_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  latest_updated_at: string | null;
};

export type BridgeStatusSummary = {
  ok: boolean;
  ran_at: string;
  partner_configured: boolean;
  secret_configured: boolean;
  cron_active: boolean;
  cron_schedule: string | null;
  resources: BridgeResourceStatus[];
};

const RESOURCES: { key: string; table: string }[] = [
  { key: "patients", table: "patients" },
  { key: "investigations", table: "investigations" },
  { key: "microbiology", table: "microbiology" },
  { key: "referrals", table: "referrals" },
  { key: "notifications", table: "notifications" },
  { key: "beds", table: "beds" },
  { key: "bed_occupancies", table: "bed_occupancies" },
  { key: "bed_outliers", table: "bed_outliers" },
  { key: "bed_transfers_out", table: "bed_transfers_out" },
];

export const getBridgeStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<BridgeStatusSummary> => {
    // Server-side admin gate: blocks non-admins even if the route is hit
    // directly, and the RPC/URL is invoked by anyone with a valid session.
    await assertAdmin(context);

    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );

    // Sync state for every resource (may be missing rows).
    const { data: stateRows } = await supabaseAdmin
      .from("bridge_sync_state")
      .select("*");
    const stateByResource = new Map<string, any>();
    (stateRows ?? []).forEach((r: any) => stateByResource.set(r.resource, r));

    // Per-resource row count + latest updated_at.
    const perResource = await Promise.all(
      RESOURCES.map(async ({ key, table }) => {
        const state = stateByResource.get(key);
        const admin = supabaseAdmin as any;
        const [{ count }, latest] = await Promise.all([
          admin
            .from(table)
            .select("id", { count: "exact", head: true }),
          admin
            .from(table)
            .select("updated_at")
            .order("updated_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
        ]);
        return {
          resource: key,
          row_count: count ?? 0,
          last_pulled_at: state?.last_pulled_at ?? null,
          last_pushed_at: state?.last_pushed_at ?? null,
          last_error: state?.last_error ?? null,
          last_error_at: state?.last_error_at ?? null,
          latest_updated_at:
            (latest.data as any)?.updated_at ?? null,
        } satisfies BridgeResourceStatus;
      }),
    );

    // Is the pg_cron job scheduled and active? cron.job is not reachable
    // over PostgREST, so use a SECURITY DEFINER RPC that returns the row.
    let cronActive = false;
    let cronSchedule: string | null = null;
    try {
      const { data: cronRows } = await (supabaseAdmin as any).rpc(
        "get_bridge_cron_state",
      );
      const row = Array.isArray(cronRows) ? cronRows[0] : cronRows;
      if (row) {
        cronActive = Boolean(row.active);
        cronSchedule = row.schedule ?? null;
      }
    } catch {
      // If the RPC is missing in an older environment, leave defaults.
    }


    return {
      ok: perResource.every((r) => !r.last_error),
      ran_at: new Date().toISOString(),
      partner_configured: Boolean(process.env.PARTNER_BRIDGE_URL),
      secret_configured: Boolean(process.env.HANDOVER_API_SECRET),
      cron_active: cronActive,
      cron_schedule: cronSchedule,
      resources: perResource,
    };
  });

export const runBridgeSyncNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);

    const url = `${process.env.SUPABASE_URL?.replace(
      /\.supabase\.co$/,
      "",
    ) ? "" : ""}`;
    // Same-origin invocation of the sync route. We rely on the platform
    // URL provided by the request; fall back to the published URL.
    const base =
      process.env.PUBLIC_APP_URL ??
      "https://critical-care-flow.lovable.app";
    void url;
    const apikey = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
    const startedAt = Date.now();
    const res = await fetch(`${base}/api/public/bridge/sync`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey,
      },
      body: "{}",
    });
    const body = await res.json().catch(() => ({}));

    // DTAC evidence: admin-triggered bridge runs are a privileged action
    // and must appear in audit_log alongside role/keypair changes.
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    await supabaseAdmin.from("audit_log").insert({
      user_id: context.userId,
      action: "update",
      entity: "bridge_sync",
      entity_id: null,
      diff: {
        source: "manual",
        scope: "all",
        http_status: res.status,
        duration_ms: Date.now() - startedAt,
        ok: res.ok,
      },
    });

    return { status: res.status, body };
  });

/**
 * Runs the sync worker restricted to the bed-related tables only:
 * beds, bed_occupancies, bed_outliers, bed_transfers_out. Useful when
 * the bed board is lagging but the partner is otherwise healthy — avoids
 * re-syncing patients/investigations/microbiology/referrals.
 */
export const runBridgeSyncBedsOnly = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);

    // Call runBridgeSync in-process with a synthetic Request carrying the
    // anon key so the shared apikey guard passes.
    const apikey = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
    const req = new Request("http://internal/bridge/sync", {
      method: "POST",
      headers: { "content-type": "application/json", apikey },
      body: "{}",
    });
    const { runBridgeSync } = await import(
      "@/routes/api/public/bridge/sync"
    );
    const startedAt = Date.now();
    const res = await runBridgeSync(req, {
      bedsOnly: true,
      source: "manual",
    });
    const body = await res.json().catch(() => ({}));

    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    await supabaseAdmin.from("audit_log").insert({
      user_id: context.userId,
      action: "update",
      entity: "bridge_sync",
      entity_id: null,
      diff: {
        source: "manual",
        scope: "beds_only",
        http_status: res.status,
        duration_ms: Date.now() - startedAt,
        ok: res.ok,
      },
    });

    return { status: res.status, body };
  });


export type BridgeProbeResult = {
  resource: string;
  status: number;
  ok: boolean;
  message: string;
};

/**
 * Probes each partner resource endpoint with an intentionally empty record.
 * A well-behaved partner responds with a 400 validation error, proving:
 *   - the endpoint is reachable
 *   - our HMAC signature is accepted (not 401)
 *   - the partner's payload validator is running
 * No rows are created because the empty payload fails validation.
 */
export const sendBridgeTestPayload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(
    async ({
      context,
    }): Promise<{
      ok: boolean;
      ran_at: string;
      partner: string;
      results: BridgeProbeResult[];
    }> => {
      await assertAdmin(context);

      const partner = process.env.PARTNER_BRIDGE_URL;
      if (!partner) throw new Error("PARTNER_BRIDGE_URL not configured");

      const { getBridgeSecrets, signWith } = await import(
        "@/lib/bridge-hmac.server"
      );
      const secrets = getBridgeSecrets();
      const actor = JSON.stringify({
        id: "critical-care-connect-probe",
        email: "probe@critical-care-connect.local",
        role: "admin",
      });

      const probes: BridgeProbeResult[] = [];
      const rawBody = JSON.stringify({ record: {}, __probe: true });
      const base = partner.replace(/\/$/, "");

      for (const key of [
        "patients",
        "investigations",
        "microbiology",
        "referrals",
        "beds",
        "bed_occupancies",
        "bed_outliers",
        "bed_transfers_out",
      ]) {
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = signWith(secrets.current, {
          timestamp,
          actor,
          rawBody,
        });
        try {
          const res = await fetch(`${base}/${key}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-timestamp": timestamp,
              "x-actor": actor,
              "x-signature": signature,
            },
            body: rawBody,
          });
          const text = (await res.text()).slice(0, 200);
          // 400 (validation error) proves the contract is intact without
          // creating a row. 401/403 mean signature/actor rejected.
          // 200/201 would be unexpected: partner accepted an empty record.
          const contractOk = res.status === 400;
          probes.push({
            resource: key,
            status: res.status,
            ok: contractOk,
            message: contractOk
              ? `Validator rejected empty payload as expected (${text || "no body"})`
              : text || `HTTP ${res.status}`,
          });
        } catch (err) {
          probes.push({
            resource: key,
            status: 0,
            ok: false,
            message: (err as Error).message,
          });
        }
      }

      // Probe hits partner endpoints with our HMAC — audit for DTAC evidence.
      const { supabaseAdmin } = await import(
        "@/integrations/supabase/client.server"
      );
      await supabaseAdmin.from("audit_log").insert({
        user_id: context.userId,
        action: "create",
        entity: "bridge_probe",
        entity_id: null,
        diff: {
          partner,
          results: probes.map((p) => ({
            resource: p.resource,
            status: p.status,
            ok: p.ok,
          })),
        },
      });

      return {
        ok: probes.every((p) => p.ok),
        ran_at: new Date().toISOString(),
        partner,
        results: probes,
      };
    },
  );

export type BridgeSyncAttempt = {
  id: number;
  attempted_at: string;
  source: "sync" | "retry" | "manual";
  resource: string;
  ok: boolean;
  pulled: number;
  pushed: number;
  duration_ms: number | null;
  error: string | null;
};

/**
 * Returns the most recent bridge sync attempts (admin-only).
 * Backs the audit log panel on the bridge status page.
 */
export const getBridgeSyncAttempts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<BridgeSyncAttempt[]> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    const { data, error } = await (supabaseAdmin as any)
      .from("bridge_sync_attempts")
      .select("id, attempted_at, source, resource, ok, pulled, pushed, duration_ms, error")
      .order("attempted_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return (data ?? []) as BridgeSyncAttempt[];
  });

export type BedBoardVerificationRow = {
  table: string;
  synced_rows: number;
  board_rows: number;
  missing_from_board: string[];
  extra_on_board: string[];
  latest_synced_at: string | null;
  last_pulled_at: string | null;
  lag_seconds: number | null;
  stale: boolean;
};

export type BedBoardVerification = {
  ran_at: string;
  ok: boolean;
  rows: BedBoardVerificationRow[];
};

// A resource is "stale" when the newest row we've received (or written locally)
// is more than this many seconds ahead of the last successful pull. Two sync
// cycles (2 min cron + slack) is a reasonable ceiling before we surface lag.
const STALE_LAG_SECONDS = 300;

/**
 * Cross-checks the bed board query against the raw synced tables.
 *
 * For each bed-related table we:
 *   1. Run the same "active" filter the bed board uses via the admin client
 *      (source of truth: what has actually been synced into our DB).
 *   2. Run getBedBoard as the calling admin (RLS applies) and diff the ID set.
 *
 * A mismatch means either RLS is hiding rows the board should see, or the
 * board query is behind realtime. We also compute lag = latest row updated_at
 * minus last_pulled_at so admins can tell when the bridge has fallen behind.
 */
export const getBedBoardVerification = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<BedBoardVerification> => {
    await assertAdmin(context);

    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    const admin = supabaseAdmin as any;

    // Same shape/filters as getBedBoard, but bypassing RLS so we see the true
    // synced state of each table.
    const [bedsRes, occRes, outRes, xferRes, stateRes, boardRes] =
      await Promise.all([
        admin
          .from("beds")
          .select("id, updated_at")
          .eq("active", true),
        admin
          .from("bed_occupancies")
          .select("id, updated_at")
          .is("discharged_at", null),
        admin
          .from("bed_outliers")
          .select("id, updated_at")
          .is("deleted_at", null)
          .is("ended_at", null),
        admin
          .from("bed_transfers_out")
          .select("id, updated_at, status")
          .is("deleted_at", null)
          .not("status", "in", "(completed,cancelled)"),
        admin
          .from("bridge_sync_state")
          .select("resource, last_pulled_at")
          .in("resource", [
            "beds",
            "bed_occupancies",
            "bed_outliers",
            "bed_transfers_out",
          ]),
        // Import lazily to avoid a cycle with beds.functions.
        (async () => {
          const { getBedBoard } = await import("@/lib/beds.functions");
          return getBedBoard();
        })(),
      ]);

    const pulledByResource = new Map<string, string | null>();
    (stateRes.data ?? []).forEach((r: any) =>
      pulledByResource.set(r.resource, r.last_pulled_at ?? null),
    );

    type SyncedRow = { id: string; updated_at: string | null };
    const buildRow = (
      table: string,
      synced: SyncedRow[],
      boardIds: string[],
    ): BedBoardVerificationRow => {
      const syncedIds = new Set(synced.map((r) => r.id));
      const boardIdSet = new Set(boardIds);
      const missing_from_board = [...syncedIds].filter(
        (id) => !boardIdSet.has(id),
      );
      const extra_on_board = boardIds.filter((id) => !syncedIds.has(id));
      const latest = synced.reduce<string | null>((acc, r) => {
        if (!r.updated_at) return acc;
        return !acc || r.updated_at > acc ? r.updated_at : acc;
      }, null);
      const lastPulled = pulledByResource.get(table) ?? null;
      const lag_seconds =
        latest && lastPulled
          ? Math.max(
              0,
              Math.round(
                (new Date(latest).getTime() -
                  new Date(lastPulled).getTime()) /
                  1000,
              ),
            )
          : null;
      const stale =
        missing_from_board.length > 0 ||
        extra_on_board.length > 0 ||
        (lag_seconds !== null && lag_seconds > STALE_LAG_SECONDS);
      return {
        table,
        synced_rows: synced.length,
        board_rows: boardIds.length,
        missing_from_board: missing_from_board.slice(0, 10),
        extra_on_board: extra_on_board.slice(0, 10),
        latest_synced_at: latest,
        last_pulled_at: lastPulled,
        lag_seconds,
        stale,
      };
    };

    const board = boardRes as Awaited<
      ReturnType<typeof import("@/lib/beds.functions").getBedBoard>
    >;

    const rows: BedBoardVerificationRow[] = [
      buildRow("beds", (bedsRes.data ?? []) as SyncedRow[], board.beds.map((b) => b.id)),
      buildRow(
        "bed_occupancies",
        (occRes.data ?? []) as SyncedRow[],
        board.occupancies.map((o) => o.id),
      ),
      buildRow(
        "bed_outliers",
        (outRes.data ?? []) as SyncedRow[],
        board.outliers.map((o) => o.id),
      ),
      buildRow(
        "bed_transfers_out",
        (xferRes.data ?? []) as SyncedRow[],
        board.transfers.map((t) => t.id),
      ),
    ];

    return {
      ran_at: new Date().toISOString(),
      ok: rows.every((r) => !r.stale),
      rows,
    };
  });


// ============================================================================
// Bed reconciliation — background job queue
// ============================================================================

export type BedReconcileItemStatus =
  | "pending"
  | "running"
  | "complete"
  | "error"
  | "locked"
  | "skipped";

export type BedReconcileJobStatus =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "cancelled";

export type BedReconcileJob = {
  id: string;
  from_ts: string;
  to_ts: string;
  dry_run: boolean;
  status: BedReconcileJobStatus;
  requested_by: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type BedReconcileJobItem = {
  id: string;
  job_id: string;
  resource: string;
  status: BedReconcileItemStatus;
  pulled: number;
  pushed: number;
  skipped: number;
  pulled_ids: string[];
  pushed_ids: string[];
  error: string | null;
  locked_since: string | null;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
};

export type BedReconcileJobDetail = {
  job: BedReconcileJob;
  items: BedReconcileJobItem[];
};

export type BedReconcileJobSummary = BedReconcileJob & {
  totals: { pulled: number; pushed: number; skipped: number; errored: number };
};

const BED_RESOURCE_ORDER = [
  "beds",
  "bed_occupancies",
  "bed_outliers",
  "bed_transfers_out",
] as const;

export const enqueueBedReconciliation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => {
    const v = (d ?? {}) as { from?: unknown; to?: unknown; dryRun?: unknown };
    const fromStr = typeof v.from === "string" ? v.from : "";
    const toStr = typeof v.to === "string" ? v.to : "";
    const fromDate = new Date(fromStr);
    const toDate = new Date(toStr);
    if (!isFinite(fromDate.getTime()) || !isFinite(toDate.getTime())) {
      throw new Error("Invalid from/to timestamps");
    }
    if (fromDate >= toDate) {
      throw new Error("'from' must be earlier than 'to'");
    }
    const spanMs = toDate.getTime() - fromDate.getTime();
    if (spanMs > 30 * 24 * 60 * 60 * 1000) {
      throw new Error("Reconciliation window cannot exceed 30 days");
    }
    return {
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      dryRun: v.dryRun === true,
    };
  })
  .handler(async ({ data, context }): Promise<{ jobId: string }> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    const admin = supabaseAdmin as any;

    const { data: job, error: jobErr } = await admin
      .from("bridge_reconcile_jobs")
      .insert({
        from_ts: data.from,
        to_ts: data.to,
        dry_run: data.dryRun,
        requested_by: context.userId,
      })
      .select("id")
      .single();
    if (jobErr) throw new Error(`enqueue job: ${jobErr.message}`);

    const itemRows = BED_RESOURCE_ORDER.map((resource) => ({
      job_id: job.id,
      resource,
    }));
    const { error: itemsErr } = await admin
      .from("bridge_reconcile_job_items")
      .insert(itemRows);
    if (itemsErr) {
      // Roll back the job so the queue doesn't hold an unrunnable stub.
      await admin.from("bridge_reconcile_jobs").delete().eq("id", job.id);
      throw new Error(`enqueue items: ${itemsErr.message}`);
    }

    return { jobId: job.id as string };
  });

export const cancelBedReconciliationJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => {
    const v = (d ?? {}) as { jobId?: unknown };
    if (typeof v.jobId !== "string" || v.jobId.length === 0) {
      throw new Error("jobId required");
    }
    return { jobId: v.jobId };
  })
  .handler(async ({ data, context }): Promise<{ cancelled: boolean }> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    const admin = supabaseAdmin as any;

    const { data: updated, error } = await admin
      .from("bridge_reconcile_jobs")
      .update({ status: "cancelled", finished_at: new Date().toISOString() })
      .eq("id", data.jobId)
      .in("status", ["queued", "running"])
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { cancelled: !!updated };
  });

export const getBedReconciliationJob = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => {
    const v = (d ?? {}) as { jobId?: unknown };
    if (typeof v.jobId !== "string" || v.jobId.length === 0) {
      throw new Error("jobId required");
    }
    return { jobId: v.jobId };
  })
  .handler(
    async ({ data, context }): Promise<BedReconcileJobDetail | null> => {
      await assertAdmin(context);
      const { supabaseAdmin } = await import(
        "@/integrations/supabase/client.server"
      );
      const admin = supabaseAdmin as any;

      const { data: job } = await admin
        .from("bridge_reconcile_jobs")
        .select("*")
        .eq("id", data.jobId)
        .maybeSingle();
      if (!job) return null;

      const { data: items } = await admin
        .from("bridge_reconcile_job_items")
        .select("*")
        .eq("job_id", data.jobId)
        .order("resource", { ascending: true });

      return {
        job: job as BedReconcileJob,
        items: (items ?? []) as BedReconcileJobItem[],
      };
    },
  );

export const listBedReconciliationJobs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => {
    const v = (d ?? {}) as { limit?: unknown };
    const limit =
      typeof v.limit === "number" && v.limit > 0 && v.limit <= 50
        ? Math.floor(v.limit)
        : 5;
    return { limit };
  })
  .handler(
    async ({ data, context }): Promise<BedReconcileJobSummary[]> => {
      await assertAdmin(context);
      const { supabaseAdmin } = await import(
        "@/integrations/supabase/client.server"
      );
      const admin = supabaseAdmin as any;

      const { data: jobs } = await admin
        .from("bridge_reconcile_jobs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(data.limit);

      if (!jobs || jobs.length === 0) return [];

      const ids = jobs.map((j: any) => j.id);
      const { data: items } = await admin
        .from("bridge_reconcile_job_items")
        .select("job_id,pulled,pushed,skipped,status")
        .in("job_id", ids);

      const totalsByJob = new Map<
        string,
        { pulled: number; pushed: number; skipped: number; errored: number }
      >();
      for (const it of (items ?? []) as any[]) {
        const t =
          totalsByJob.get(it.job_id) ??
          { pulled: 0, pushed: 0, skipped: 0, errored: 0 };
        t.pulled += it.pulled ?? 0;
        t.pushed += it.pushed ?? 0;
        t.skipped += it.skipped ?? 0;
        if (it.status === "error") t.errored += 1;
        totalsByJob.set(it.job_id, t);
      }

      return (jobs as any[]).map((j) => ({
        ...(j as BedReconcileJob),
        totals: totalsByJob.get(j.id) ?? {
          pulled: 0,
          pushed: 0,
          skipped: 0,
          errored: 0,
        },
      }));
    },
  );



