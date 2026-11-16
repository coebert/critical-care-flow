/**
 * In-memory stand-in for patient_wardable_status + the durable revision
 * counter + set_wardable_desired_state(), mirroring the staged migration
 * drizzle/staged/0003_wardable_revision_fence.sql. Synthetic data only.
 */
import { fakeTable } from "./fake-table";

export function fakeWardableDb(opts: { rpcMissing?: boolean; clinical?: boolean } = {}) {
  const t = fakeTable("partner_patient_id", []);
  const counters = new Map<string, number>();
  let clock = Date.parse("2026-11-16T11:00:00.000Z");
  const db = {
    from: () => t.table,
    rpc: async (fn: string, args: { _partner_patient_id: string; _wardable: boolean }) => {
      if (opts.rpcMissing || fn !== "set_wardable_desired_state") {
        return { data: null, error: { code: "PGRST202", message: "function not found" } };
      }
      if (opts.clinical === false) return { data: null, error: { code: "42501", message: "forbidden" } };
      const id = args._partner_patient_id;
      const rev = (counters.get(id) ?? 0) + 1;
      counters.set(id, rev);
      clock += 1000;
      const nowIso = new Date(clock).toISOString();
      const existing = t.rows.find((r) => r.partner_patient_id === id);
      const wardable_at = args._wardable ? (existing?.wardable ? existing.wardable_at : nowIso) : null;
      const next = {
        partner_patient_id: id,
        wardable: args._wardable,
        wardable_at,
        discharged_at: null,
        updated_at: nowIso,
        desired_revision: rev,
        partner_sync_status: "pending",
        partner_sync_checked_at: null,
        partner_synced_revision: existing?.partner_synced_revision ?? null,
      };
      if (existing) Object.assign(existing, next);
      else t.rows.push(next);
      return { data: [{ ...next }], error: null };
    },
  };
  return {
    db,
    rows: t.rows,
    counters,
    hooks: t.hooks,
    row: (id: string) => t.rows.find((r) => r.partner_patient_id === id),
    /** Outbox cleanup / overlay deletion: the counter is NOT reset. */
    deleteRow: (id: string) => {
      const i = t.rows.findIndex((r) => r.partner_patient_id === id);
      if (i >= 0) t.rows.splice(i, 1);
    },
  };
}
