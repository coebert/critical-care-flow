import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_SKEW_SECONDS = 300;

export type BridgeActor = {
  id: string;
  email?: string;
  role: "admin" | "clinician" | "system";
};

export type SignedRequestInput = {
  timestamp: string; // seconds since epoch, as string
  actor: string; // JSON-encoded BridgeActor
  rawBody: string;
};

function buildBase(input: SignedRequestInput): string {
  return `${input.timestamp}.${input.actor}.${input.rawBody}`;
}

export function signWith(secret: string, input: SignedRequestInput): string {
  return createHmac("sha256", secret).update(buildBase(input)).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export type VerifyResult =
  | { valid: true; secretUsed: "current" | "previous" }
  | { valid: false; reason: string };

export function verifySignature(params: {
  currentSecret: string;
  previousSecret?: string | null;
  timestamp: string;
  actor: string;
  rawBody: string;
  signature: string;
  nowSeconds?: number;
}): VerifyResult {
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tsNum = Number(params.timestamp);
  if (!Number.isFinite(tsNum)) return { valid: false, reason: "invalid_timestamp" };
  if (Math.abs(now - tsNum) > MAX_SKEW_SECONDS) {
    return { valid: false, reason: "timestamp_skew_exceeded" };
  }

  const input = {
    timestamp: params.timestamp,
    actor: params.actor,
    rawBody: params.rawBody,
  };

  const current = signWith(params.currentSecret, input);
  if (safeEqualHex(current, params.signature)) {
    return { valid: true, secretUsed: "current" };
  }
  if (params.previousSecret) {
    const prev = signWith(params.previousSecret, input);
    if (safeEqualHex(prev, params.signature)) {
      return { valid: true, secretUsed: "previous" };
    }
  }
  return { valid: false, reason: "signature_mismatch" };
}

export function getBridgeSecrets() {
  const current = process.env.HANDOVER_API_SECRET;
  if (!current) throw new Error("HANDOVER_API_SECRET is not configured");
  return {
    current,
    previous: process.env.HANDOVER_API_SECRET_PREVIOUS || null,
  };
}
