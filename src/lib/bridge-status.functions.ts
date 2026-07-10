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

