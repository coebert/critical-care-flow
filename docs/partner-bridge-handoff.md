# Partner App Handoff — Missing Bridge Endpoints

The ICU Handover app (this project) pulls bed data from the partner ICU Compass Care
app every 2 minutes. Three endpoints are missing on the partner side and currently
return 404:

- `GET/POST /api/public/bridge/bed_occupancies`
- `GET/POST /api/public/bridge/bed_outliers`
- `GET/POST /api/public/bridge/bed_transfers_out`

The partner already exposes `/api/public/bridge/beds` using the same scheme,
so the shared helpers should already exist over there. Please add the three
route files below verbatim.

## Shared expectations

- HMAC scheme identical to `/beds`: `x-timestamp` (unix seconds), `x-actor`
  (JSON `{id, email?, role}` where role ∈ `admin|clinician|system`),
  `x-signature` (`hex(hmac_sha256(secret, "${ts}.${actor}.${rawBody}"))`).
  Skew window ±300s. Same `HANDOVER_API_SECRET` (+ optional
  `HANDOVER_API_SECRET_PREVIOUS`) used for `/beds`.
- Tables `bed_occupancies`, `bed_outliers`, `bed_transfers_out` must have an
  `updated_at` timestamptz column (used for `since` incremental pulls).
- Column allowlists below are the portable set we sync — extra columns on the
  partner side are fine, they're just filtered out on write.
- Assumes the partner already has `@/lib/bridge-cors`, `@/lib/bridge-verify.server`,
  `@/lib/bridge-hmac.server`, `@/lib/bridge-actor`, and
  `@/integrations/supabase/client.server` (all present in this repo — copy
  across if missing).

---

## `src/routes/api/public/bridge/bed_occupancies.ts`

```ts
import { createFileRoute } from "@tanstack/react-router";
import { jsonResponse, preflight } from "@/lib/bridge-cors";
import {
  parseBridgeBody,
  pickAllowed,
  verifyBridgeRequest,
} from "@/lib/bridge-verify.server";

const BED_OCCUPANCY_COLUMNS = [
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
] as const;

export const Route = createFileRoute("/api/public/bridge/bed_occupancies")({
  server: {
    handlers: {
      OPTIONS: async () => preflight(),

      GET: async ({ request }) => {
        const verified = await verifyBridgeRequest(request);
        if (verified instanceof Response) return verified;

        const url = new URL(request.url);
        const since = url.searchParams.get("since");
        const limit = Math.min(
          Number(url.searchParams.get("limit") ?? "500") || 500,
          1000,
        );

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );
        let q = supabaseAdmin
          .from("bed_occupancies")
          .select("*")
          .order("updated_at", { ascending: true })
          .limit(limit);
        if (since) q = q.gt("updated_at", since);

        const { data, error } = await q;
        if (error) return jsonResponse({ error: error.message }, { status: 500 });
        return jsonResponse({ records: data ?? [] });
      },

      POST: async ({ request }) => {
        const verified = await verifyBridgeRequest(request, {
          requireWrite: true,
        });
        if (verified instanceof Response) return verified;

        const parsed = parseBridgeBody(verified.rawBody);
        if ("error" in parsed) {
          return jsonResponse({ error: parsed.error }, { status: 400 });
        }

        const picked = pickAllowed(parsed.record, BED_OCCUPANCY_COLUMNS);
        if ("error" in picked) return jsonResponse(picked, { status: 400 });
        const record = picked.data;

        for (const required of ["bed_id", "admitted_at", "level"]) {
          if (record[required] === undefined || record[required] === null) {
            return jsonResponse(
              { error: `${required}_required` },
              { status: 400 },
            );
          }
        }

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );

        if (record.id && parsed.expectedUpdatedAt) {
          const { data: existing } = await supabaseAdmin
            .from("bed_occupancies")
            .select("id, updated_at")
            .eq("id", record.id as string)
            .maybeSingle();
          if (existing && existing.updated_at !== parsed.expectedUpdatedAt) {
            const { data: full } = await supabaseAdmin
              .from("bed_occupancies")
              .select("*")
              .eq("id", record.id as string)
              .maybeSingle();
            return jsonResponse(
              { error: "concurrent_modification", current: full },
              { status: 409 },
            );
          }
        }

        const { data, error } = await supabaseAdmin
          .from("bed_occupancies")
          .upsert(record as any, { onConflict: "id" })
          .select("*")
          .single();
        if (error) return jsonResponse({ error: error.message }, { status: 500 });

        await supabaseAdmin.from("audit_log").insert({
          user_id: null,
          action: "update",
          entity: "bed_occupancy",
          entity_id: data.id,
          diff: {
            source: "handover_bridge",
            actor: verified.actor,
            record: record as any,
          },
        });

        return jsonResponse({ record: data });
      },
    },
  },
});
```

---

## `src/routes/api/public/bridge/bed_outliers.ts`

```ts
import { createFileRoute } from "@tanstack/react-router";
import { jsonResponse, preflight } from "@/lib/bridge-cors";
import {
  parseBridgeBody,
  pickAllowed,
  verifyBridgeRequest,
} from "@/lib/bridge-verify.server";

const BED_OUTLIER_COLUMNS = [
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
] as const;

export const Route = createFileRoute("/api/public/bridge/bed_outliers")({
  server: {
    handlers: {
      OPTIONS: async () => preflight(),

      GET: async ({ request }) => {
        const verified = await verifyBridgeRequest(request);
        if (verified instanceof Response) return verified;

        const url = new URL(request.url);
        const since = url.searchParams.get("since");
        const limit = Math.min(
          Number(url.searchParams.get("limit") ?? "500") || 500,
          1000,
        );

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );
        let q = supabaseAdmin
          .from("bed_outliers")
          .select("*")
          .order("updated_at", { ascending: true })
          .limit(limit);
        if (since) q = q.gt("updated_at", since);

        const { data, error } = await q;
        if (error) return jsonResponse({ error: error.message }, { status: 500 });
        return jsonResponse({ records: data ?? [] });
      },

      POST: async ({ request }) => {
        const verified = await verifyBridgeRequest(request, {
          requireWrite: true,
        });
        if (verified instanceof Response) return verified;

        const parsed = parseBridgeBody(verified.rawBody);
        if ("error" in parsed) {
          return jsonResponse({ error: parsed.error }, { status: 400 });
        }

        const picked = pickAllowed(parsed.record, BED_OUTLIER_COLUMNS);
        if ("error" in picked) return jsonResponse(picked, { status: 400 });
        const record = picked.data;

        for (const required of ["ward", "started_at", "level"]) {
          if (record[required] === undefined || record[required] === null) {
            return jsonResponse(
              { error: `${required}_required` },
              { status: 400 },
            );
          }
        }

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );

        if (record.id && parsed.expectedUpdatedAt) {
          const { data: existing } = await supabaseAdmin
            .from("bed_outliers")
            .select("id, updated_at")
            .eq("id", record.id as string)
            .maybeSingle();
          if (existing && existing.updated_at !== parsed.expectedUpdatedAt) {
            const { data: full } = await supabaseAdmin
              .from("bed_outliers")
              .select("*")
              .eq("id", record.id as string)
              .maybeSingle();
            return jsonResponse(
              { error: "concurrent_modification", current: full },
              { status: 409 },
            );
          }
        }

        const { data, error } = await supabaseAdmin
          .from("bed_outliers")
          .upsert(record as any, { onConflict: "id" })
          .select("*")
          .single();
        if (error) return jsonResponse({ error: error.message }, { status: 500 });

        await supabaseAdmin.from("audit_log").insert({
          user_id: null,
          action: "update",
          entity: "bed_outlier",
          entity_id: data.id,
          diff: {
            source: "handover_bridge",
            actor: verified.actor,
            record: record as any,
          },
        });

        return jsonResponse({ record: data });
      },
    },
  },
});
```

---

## `src/routes/api/public/bridge/bed_transfers_out.ts`

```ts
import { createFileRoute } from "@tanstack/react-router";
import { jsonResponse, preflight } from "@/lib/bridge-cors";
import {
  parseBridgeBody,
  pickAllowed,
  verifyBridgeRequest,
} from "@/lib/bridge-verify.server";

const BED_TRANSFER_COLUMNS = [
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
] as const;

export const Route = createFileRoute("/api/public/bridge/bed_transfers_out")({
  server: {
    handlers: {
      OPTIONS: async () => preflight(),

      GET: async ({ request }) => {
        const verified = await verifyBridgeRequest(request);
        if (verified instanceof Response) return verified;

        const url = new URL(request.url);
        const since = url.searchParams.get("since");
        const limit = Math.min(
          Number(url.searchParams.get("limit") ?? "500") || 500,
          1000,
        );

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );
        let q = supabaseAdmin
          .from("bed_transfers_out")
          .select("*")
          .order("updated_at", { ascending: true })
          .limit(limit);
        if (since) q = q.gt("updated_at", since);

        const { data, error } = await q;
        if (error) return jsonResponse({ error: error.message }, { status: 500 });
        return jsonResponse({ records: data ?? [] });
      },

      POST: async ({ request }) => {
        const verified = await verifyBridgeRequest(request, {
          requireWrite: true,
        });
        if (verified instanceof Response) return verified;

        const parsed = parseBridgeBody(verified.rawBody);
        if ("error" in parsed) {
          return jsonResponse({ error: parsed.error }, { status: 400 });
        }

        const picked = pickAllowed(parsed.record, BED_TRANSFER_COLUMNS);
        if ("error" in picked) return jsonResponse(picked, { status: 400 });
        const record = picked.data;

        for (const required of [
          "kind",
          "destination_hospital",
          "status",
          "requested_at",
        ]) {
          if (record[required] === undefined || record[required] === null) {
            return jsonResponse(
              { error: `${required}_required` },
              { status: 400 },
            );
          }
        }

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );

        if (record.id && parsed.expectedUpdatedAt) {
          const { data: existing } = await supabaseAdmin
            .from("bed_transfers_out")
            .select("id, updated_at")
            .eq("id", record.id as string)
            .maybeSingle();
          if (existing && existing.updated_at !== parsed.expectedUpdatedAt) {
            const { data: full } = await supabaseAdmin
              .from("bed_transfers_out")
              .select("*")
              .eq("id", record.id as string)
              .maybeSingle();
            return jsonResponse(
              { error: "concurrent_modification", current: full },
              { status: 409 },
            );
          }
        }

        const { data, error } = await supabaseAdmin
          .from("bed_transfers_out")
          .upsert(record as any, { onConflict: "id" })
          .select("*")
          .single();
        if (error) return jsonResponse({ error: error.message }, { status: 500 });

        await supabaseAdmin.from("audit_log").insert({
          user_id: null,
          action: "update",
          entity: "bed_transfer_out",
          entity_id: data.id,
          diff: {
            source: "handover_bridge",
            actor: verified.actor,
            record: record as any,
          },
        });

        return jsonResponse({ record: data });
      },
    },
  },
});
```

---

## Verification (partner side)

After publishing, these should each return 200 (with valid signed headers)
instead of 404:

```
GET  https://icu-compass-care.lovable.app/api/public/bridge/bed_occupancies
GET  https://icu-compass-care.lovable.app/api/public/bridge/bed_outliers
GET  https://icu-compass-care.lovable.app/api/public/bridge/bed_transfers_out
```

Once live, this app's every-2-min reconcile will start populating the
bed board automatically — no further changes needed on our side.
