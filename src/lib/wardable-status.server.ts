/**
 * Server-only helper: forwards a wardable state change to the partner app
 * over the signed bridge. Keeps HMAC + fetch out of the RPC module so the
 * client bundle stays clean.
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

  const bodyObj = {
    id: input.partner_patient_id,
    wardable: input.wardable,
    wardable_at: input.wardable_at,
  };
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
    // Partner may not yet accept the wardable/wardable_at fields — log and
    // move on; the local record still drives the timer and analytics.
    const text = await res.text().catch(() => "");
    console.warn(`[wardable] partner responded ${res.status}: ${text.slice(0, 200)}`);
  }
}
