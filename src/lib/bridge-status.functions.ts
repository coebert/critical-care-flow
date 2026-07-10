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
    const res = await fetch(`${base}/api/public/bridge/sync`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey,
      },
      body: "{}",
    });
    const body = await res.json().catch(() => ({}));
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
    const res = await runBridgeSync(req, {
      bedsOnly: true,
      source: "manual",
    });
    const body = await res.json().catch(() => ({}));
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


export type BedReconcileResourceResult = {
  resource: string;
  pulled: number;
  pushed: number;
  skipped: number;
  error: string | null;
};

export type BedReconcileResult = {
  ok: boolean;
  ran_at: string;
  from: string;
  to: string;
  results: BedReconcileResourceResult[];
};

/**
 * Reconciliation/backfill for bed-related tables in a chosen time window.
 *
 * For each bed resource we:
 *   - Pull partner rows updated since `from` (partner's cursor param).
 *   - Re-push every local row with updated_at in [from, to], bypassing the
 *     regular push cursor so already-synced rows are resent to the partner.
 *
 * Cursors in bridge_sync_state are intentionally NOT touched — reconcile is
 * a safety-net run for when the board looks stale; the scheduled sync
 * continues from its own cursor as normal on the next tick.
 */
export const runBedReconciliation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => {
    const v = (d ?? {}) as { from?: unknown; to?: unknown };
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
    // Guardrail: cap window at 30 days to prevent runaway re-pushes.
    if (spanMs > 30 * 24 * 60 * 60 * 1000) {
      throw new Error("Reconciliation window cannot exceed 30 days");
    }
    return { from: fromDate.toISOString(), to: toDate.toISOString() };
  })
  .handler(async ({ data, context }): Promise<BedReconcileResult> => {
    await assertAdmin(context);

    const partner = process.env.PARTNER_BRIDGE_URL;
    if (!partner) throw new Error("PARTNER_BRIDGE_URL not configured");

    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    const admin = supabaseAdmin as any;

    // Reuse the exact push/pull/HMAC helpers from the scheduled sync so the
    // partner sees identical signed payloads.
    const sync = await import("@/routes/api/public/bridge/sync");
    const bedResources = sync.RESOURCES.filter((r) =>
      sync.BED_RESOURCE_KEYS.includes(r.key),
    );

    const results: BedReconcileResourceResult[] = [];
    for (const resource of bedResources) {
      const startedMs = Date.now();
      let pulled = 0;
      let pushed = 0;
      let skipped = 0;
      let error: string | null = null;

      try {
        // PULL — partner API only supports a `since` cursor, so we pass
        // `from` and post-filter to the window client-side.
        const incoming = await sync.pullResource(
          partner,
          resource.key,
          data.from,
        );
        const inWindow = incoming.filter((r) => {
          const u = (r as any).updated_at as string | undefined;
          return !u || (u >= data.from && u <= data.to);
        });
        if (inWindow.length > 0) {
          const { error: upErr } = await admin
            .from(resource.table)
            .upsert(inWindow as any, { onConflict: resource.conflict });
          if (upErr) throw new Error(`local upsert: ${upErr.message}`);
          pulled = inWindow.length;
        }
        skipped = incoming.length - inWindow.length;

        // PUSH — every local row updated inside the window, ignoring
        // last_pushed_at so previously-synced rows are resent.
        const { data: batch, error: readErr } = await admin
          .from(resource.table)
          .select(resource.select)
          .gte("updated_at", data.from)
          .lte("updated_at", data.to)
          .order("updated_at", { ascending: true })
          .limit(2000);
        if (readErr) throw new Error(`local read: ${readErr.message}`);
        for (const row of (batch ?? []) as Record<string, unknown>[]) {
          await sync.pushOne(
            partner,
            resource.key,
            sync.toPortable(resource.key, row),
          );
          pushed += 1;
        }
      } catch (err) {
        error = (err as Error).message;
      }

      // Audit every attempt so admins can see reconciliation runs alongside
      // scheduled syncs and auto-retries.
      await admin
        .from("bridge_sync_attempts")
        .insert({
          source: "manual",
          resource: resource.key,
          ok: !error,
          pulled,
          pushed,
          duration_ms: Date.now() - startedMs,
          error: error ?? `reconcile ${data.from} → ${data.to}`,
        })
        .then(
          () => {},
          () => {},
        );

      results.push({
        resource: resource.key,
        pulled,
        pushed,
        skipped,
        error,
      });
    }

    return {
      ok: results.every((r) => !r.error),
      ran_at: new Date().toISOString(),
      from: data.from,
      to: data.to,
      results,
    };
  });
