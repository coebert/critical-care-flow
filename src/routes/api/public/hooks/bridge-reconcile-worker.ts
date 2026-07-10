import { createFileRoute } from "@tanstack/react-router";

/**
 * Background worker that drains the bed reconciliation job queue.
 *
 * Triggered on:
 *   - INSERT trigger on bridge_reconcile_jobs (fires within ~1s of enqueue)
 *   - pg_cron every minute as a backstop
 *   - Manually via curl for debugging
 *
 * The trigger + cron may fire concurrently; the atomic UPDATE ... RETURNING
 * on status='queued' guarantees at most one worker owns each job.
 */

const STALE_RUNNING_MS = 10 * 60 * 1000; // release after 10 min without finish
const RECONCILE_LOCK_STALE_MS = 10 * 60 * 1000;
const ID_SAMPLE_CAP = 50;
const PROGRESS_FLUSH_EVERY = 25; // update the item row every N pushed rows

function isAuthorized(request: Request): boolean {
  const anon = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!anon) return false;
  const supplied =
    request.headers.get("apikey") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    null;
  return typeof supplied === "string" && supplied === anon;
}

async function claimNextJob(admin: any): Promise<any | null> {
  // Recover stale runs (worker crashed / Worker request timed out).
  const staleCutoff = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
  await admin
    .from("bridge_reconcile_jobs")
    .update({ status: "queued", started_at: null })
    .eq("status", "running")
    .lt("started_at", staleCutoff);

  // Pick the oldest queued job. Two workers racing here both filter by
  // status='queued'; whichever UPDATE lands first wins because status flips
  // to 'running' inside the same statement.
  const { data: candidates, error: pickErr } = await admin
    .from("bridge_reconcile_jobs")
    .select("id")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1);
  if (pickErr || !candidates || candidates.length === 0) return null;
  const candidateId = candidates[0].id;

  const { data: claimed, error: claimErr } = await admin
    .from("bridge_reconcile_jobs")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", candidateId)
    .eq("status", "queued")
    .select("*")
    .maybeSingle();
  if (claimErr || !claimed) return null;
  return claimed;
}

async function jobIsCancelled(admin: any, jobId: string): Promise<boolean> {
  const { data } = await admin
    .from("bridge_reconcile_jobs")
    .select("status")
    .eq("id", jobId)
    .maybeSingle();
  return (data as any)?.status === "cancelled";
}

async function processJob(admin: any, job: any) {
  const partner = process.env.PARTNER_BRIDGE_URL;
  if (!partner) {
    await admin
      .from("bridge_reconcile_jobs")
      .update({
        status: "failed",
        error: "PARTNER_BRIDGE_URL not configured",
        finished_at: new Date().toISOString(),
      })
      .eq("id", job.id);
    return;
  }

  const sync = await import("@/routes/api/public/bridge/sync");
  const bedResources = sync.RESOURCES.filter((r) =>
    sync.BED_RESOURCE_KEYS.includes(r.key),
  );

  const { data: existingItems } = await admin
    .from("bridge_reconcile_job_items")
    .select("*")
    .eq("job_id", job.id);

  const byResource = new Map<string, any>();
  for (const it of (existingItems ?? []) as any[]) {
    byResource.set(it.resource, it);
  }

  for (const resource of bedResources) {
    if (await jobIsCancelled(admin, job.id)) break;

    let item = byResource.get(resource.key);
    if (!item) {
      const { data: inserted } = await admin
        .from("bridge_reconcile_job_items")
        .insert({ job_id: job.id, resource: resource.key })
        .select("*")
        .maybeSingle();
      item = inserted;
    }
    if (!item || item.status === "complete" || item.status === "error") {
      continue; // already finalized by an earlier attempt
    }

    const startedMs = Date.now();
    await admin
      .from("bridge_reconcile_job_items")
      .update({
        status: "running",
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        error: null,
      })
      .eq("id", item.id);

    let pulled = 0;
    let pushed = 0;
    let skipped = 0;
    let error: string | null = null;
    let locked = false;
    let lockedSince: string | null = null;
    let lockId: string | null = null;
    const pulledIds: string[] = [];
    const pushedIds: string[] = [];

    // Lock acquisition — skipped for dry-runs (read-only, no conflict).
    if (!job.dry_run) {
      const staleCutoff = new Date(
        Date.now() - RECONCILE_LOCK_STALE_MS,
      ).toISOString();
      await admin
        .from("bridge_reconcile_locks")
        .delete()
        .eq("resource", resource.key)
        .eq("from_ts", job.from_ts)
        .eq("to_ts", job.to_ts)
        .lt("locked_at", staleCutoff);

      const { data: inserted, error: lockErr } = await admin
        .from("bridge_reconcile_locks")
        .insert({
          resource: resource.key,
          from_ts: job.from_ts,
          to_ts: job.to_ts,
          locked_by: job.requested_by,
        })
        .select("id")
        .maybeSingle();

      if (lockErr) {
        if ((lockErr as any).code === "23505") {
          const { data: holder } = await admin
            .from("bridge_reconcile_locks")
            .select("locked_at")
            .eq("resource", resource.key)
            .eq("from_ts", job.from_ts)
            .eq("to_ts", job.to_ts)
            .maybeSingle();
          locked = true;
          lockedSince = (holder as any)?.locked_at ?? null;
          error = "Another reconcile is already running for this window";
        } else {
          error = `lock acquire: ${lockErr.message}`;
        }
      } else {
        lockId = (inserted as any)?.id ?? null;
      }
    }

    if (!locked && !error) {
      try {
        const incoming = await sync.pullResource(
          partner,
          resource.key,
          job.from_ts,
        );
        const inWindow = incoming.filter((r) => {
          const u = (r as any).updated_at as string | undefined;
          return !u || (u >= job.from_ts && u <= job.to_ts);
        });
        for (const r of inWindow) {
          const id = (r as any).id;
          if (id != null) pulledIds.push(String(id));
        }
        if (inWindow.length > 0 && !job.dry_run) {
          const { error: upErr } = await admin
            .from(resource.table)
            .upsert(inWindow as any, { onConflict: resource.conflict });
          if (upErr) throw new Error(`local upsert: ${upErr.message}`);
        }
        pulled = inWindow.length;
        skipped = incoming.length - inWindow.length;

        // Flush pull counts before starting push.
        await admin
          .from("bridge_reconcile_job_items")
          .update({
            pulled,
            skipped,
            pulled_ids: pulledIds.slice(0, ID_SAMPLE_CAP),
            updated_at: new Date().toISOString(),
          })
          .eq("id", item.id);

        const { data: batch, error: readErr } = await admin
          .from(resource.table)
          .select(resource.select)
          .gte("updated_at", job.from_ts)
          .lte("updated_at", job.to_ts)
          .order("updated_at", { ascending: true })
          .limit(2000);
        if (readErr) throw new Error(`local read: ${readErr.message}`);

        for (const row of (batch ?? []) as Record<string, unknown>[]) {
          if (await jobIsCancelled(admin, job.id)) {
            error = "Cancelled by admin";
            break;
          }
          const id = (row as any).id;
          if (id != null) pushedIds.push(String(id));
          if (!job.dry_run) {
            await sync.pushOne(
              partner,
              resource.key,
              sync.toPortable(resource.key, row),
            );
          }
          pushed += 1;

          // Stream progress so the UI live-counts pushes.
          if (pushed % PROGRESS_FLUSH_EVERY === 0) {
            await admin
              .from("bridge_reconcile_job_items")
              .update({
                pushed,
                pushed_ids: pushedIds.slice(0, ID_SAMPLE_CAP),
                updated_at: new Date().toISOString(),
              })
              .eq("id", item.id);
          }
        }
      } catch (err) {
        if (err instanceof sync.PartnerEndpointMissingError) {
          // Partner app doesn't expose this bridge endpoint — treat as a
          // clean skip so the job doesn't fail on the whole window.
          skipped += 1;
          error = null;
        } else {
          error = (err as Error).message;
        }
      }


    }

    if (lockId) {
      await admin
        .from("bridge_reconcile_locks")
        .delete()
        .eq("id", lockId)
        .then(
          () => {},
          () => {},
        );
    }

    const finalStatus: string = locked
      ? "locked"
      : error
        ? "error"
        : "complete";
    await admin
      .from("bridge_reconcile_job_items")
      .update({
        status: finalStatus,
        pulled,
        pushed,
        skipped,
        pulled_ids: pulledIds.slice(0, ID_SAMPLE_CAP),
        pushed_ids: pushedIds.slice(0, ID_SAMPLE_CAP),
        error,
        locked_since: lockedSince,
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", item.id);

    if (!job.dry_run && !locked) {
      await admin
        .from("bridge_sync_attempts")
        .insert({
          source: "manual",
          resource: resource.key,
          ok: !error,
          pulled,
          pushed,
          duration_ms: Date.now() - startedMs,
          error: error ?? `reconcile ${job.from_ts} → ${job.to_ts}`,
        })
        .then(
          () => {},
          () => {},
        );
    }
  }

  // Finalize job status. If it was cancelled mid-flight leave it cancelled.
  const { data: fresh } = await admin
    .from("bridge_reconcile_jobs")
    .select("status")
    .eq("id", job.id)
    .maybeSingle();
  if ((fresh as any)?.status === "cancelled") {
    await admin
      .from("bridge_reconcile_jobs")
      .update({ finished_at: new Date().toISOString() })
      .eq("id", job.id);
    return;
  }

  const { data: finalItems } = await admin
    .from("bridge_reconcile_job_items")
    .select("status,error")
    .eq("job_id", job.id);
  const anyError = (finalItems ?? []).some(
    (i: any) => i.status === "error" && i.error,
  );
  await admin
    .from("bridge_reconcile_jobs")
    .update({
      status: anyError ? "failed" : "complete",
      finished_at: new Date().toISOString(),
    })
    .eq("id", job.id);
}

export const Route = createFileRoute("/api/public/hooks/bridge-reconcile-worker")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthorized(request)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );
        const admin = supabaseAdmin as any;

        // Drain up to 3 jobs per invocation so a burst enqueue doesn't wait
        // a full minute for the cron backstop between jobs.
        const processed: string[] = [];
        for (let i = 0; i < 3; i++) {
          const job = await claimNextJob(admin);
          if (!job) break;
          try {
            await processJob(admin, job);
          } catch (err) {
            await admin
              .from("bridge_reconcile_jobs")
              .update({
                status: "failed",
                error: (err as Error).message,
                finished_at: new Date().toISOString(),
              })
              .eq("id", job.id);
          }
          processed.push(job.id);
        }

        return Response.json({ ok: true, processed });
      },
    },
  },
});
