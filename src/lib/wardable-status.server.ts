/**
 * Server-only helper: forwards a wardable state change to the partner app
 * over the signed bridge. Keeps HMAC + fetch out of the RPC module so the
 * client bundle stays clean.
 *
 * Partner contract (`POST /api/public/bridge/patients`, see ICU Handover
 * Hub `src/routes/api/public/bridge.patients.ts`):
 *  - `full_name` is required (min 1) — a wardable-only patch is rejected
 *    with 400 "Invalid patient payload" if it's missing.
 *  - `expected_updated_at` enables optimistic concurrency; when it matches
 *    the partner's current `updated_at` the write goes through, otherwise
 *    a 409 conflict is returned.
 *
 * We hydrate both from our local `patients` mirror (populated by the
 * scheduled bridge pull) so the wardable toggle can push a minimal, valid
 * patch. If the mirror doesn't have the patient yet, we still attempt the
 * push without `expected_updated_at` — the partner will apply it as long
 * as `full_name` is present.
 */
export async function pushWardableToPartner(input: {
  partner_patient_id: string;
  wardable: boolean;
  wardable_at: string | null;
  userId: string;
  claims: Record<string, unknown>;
}): Promise<void> {
  const base = process.env.PARTNER_BRIDGE_URL;
  if (!base) return; // no bridge configured — local-only is fine

  const { getBridgeSecrets } = await import("./bridge-hmac.server");
  const secret = getBridgeSecrets().current;

  const email =
    typeof input.claims.email === "string" ? (input.claims.email as string) : undefined;
  const actor = JSON.stringify({ id: input.userId, email, role: "clinician" });

  // Hydrate full_name + expected_updated_at from our local mirror of the
  // partner's `patients` table — populated by the scheduled bridge pull.
  let fullName: string | null = null;
  let expectedUpdatedAt: string | null = null;
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await supabaseAdmin
      .from("patients")
      .select("full_name, updated_at")
      .eq("id", input.partner_patient_id)
      .maybeSingle();
    if (row) {
      fullName = (row as { full_name: string | null }).full_name ?? null;
      expectedUpdatedAt = (row as { updated_at: string | null }).updated_at ?? null;
    }
  } catch (err) {
    console.warn("[wardable] could not read local patient mirror", err);
  }

  if (!fullName) {
    // Partner requires `full_name` on every upsert. Without it the request
    // is a guaranteed 400 — bail out and log so the timer/analytics still
    // work locally.
    console.warn(
      `[wardable] skipping partner push for ${input.partner_patient_id}: full_name not in local mirror yet`,
    );
    return;
  }

  const bodyObj: Record<string, unknown> = {
    id: input.partner_patient_id,
    full_name: fullName,
    wardable: input.wardable,
    wardable_at: input.wardable_at,
    wardable_by: input.userId,
  };
  if (expectedUpdatedAt) bodyObj.expected_updated_at = expectedUpdatedAt;

  const rawBody = JSON.stringify(bodyObj);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const { createHmac } = await import("node:crypto");
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${actor}.${rawBody}`)
    .digest("hex");

  const url = `${base.replace(/\/$/, "")}/patients`;
  const res = await fetch(url, {
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
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn(`[wardable] partner responded ${res.status}: ${text.slice(0, 200)}`);
  }
}
