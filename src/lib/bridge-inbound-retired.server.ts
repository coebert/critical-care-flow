import { jsonResponse } from "./bridge-cors";
import { verifyBridgeRequest } from "./bridge-verify.server";

/**
 * Inbound mirror WRITES over the HMAC bridge are retired.
 *
 * Ownership: CCC owns referrals, investigations and microbiology (the Hub
 * pulls them read-only through the versioned `?sync=1` feed); the Hub owns
 * patients, beds and placement (CCC reads those live from the Hub). No
 * legitimate caller writes any of them into CCC over the bridge, and the old
 * handlers did a non-atomic read-then-upsert that let a stale or
 * revision-less caller overwrite a native edit.
 *
 * The refusal stays authenticated (unsigned/tampered/unknown-role callers get
 * exactly the errors they got before) and touches nothing: no read, no
 * write, no audit row, no record echoed back.
 */
export const INBOUND_WRITE_RETIRED_MESSAGE =
  "Bridge writes to this resource are retired. Critical Care Connect owns referrals, investigations and microbiology (edit them in Critical Care Connect; ICU Handover Hub pulls them read-only). ICU Handover Hub owns patients, beds and placement.";

export type RetiredInboundResource =
  | "referrals"
  | "investigations"
  | "microbiology"
  | "patients"
  | "beds"
  | "bed_occupancies"
  | "bed_outliers"
  | "bed_transfers_out";

export async function refuseRetiredInboundWrite(
  request: Request,
  resource: RetiredInboundResource,
): Promise<Response> {
  const verified = await verifyBridgeRequest(request, { requireWrite: true });
  if (verified instanceof Response) return verified;
  // Metadata only — never the body, signature or record values.
  console.warn("[bridge] refused retired inbound write", resource, verified.actor.role);
  return jsonResponse(
    {
      error: "inbound_mirror_write_retired",
      resource,
      mutations: 0,
      message: INBOUND_WRITE_RETIRED_MESSAGE,
    },
    { status: 410 },
  );
}
