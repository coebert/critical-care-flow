import type { BridgeActor } from "./bridge-hmac.server";

export const ALLOWED_ROLES: BridgeActor["role"][] = ["admin", "clinician", "system"];

export function parseActorHeader(raw: string | null): BridgeActor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<BridgeActor>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.id !== "string" || !parsed.id) return null;
    if (typeof parsed.role !== "string") return null;
    if (!ALLOWED_ROLES.includes(parsed.role as BridgeActor["role"])) return null;
    return {
      id: parsed.id,
      email: typeof parsed.email === "string" ? parsed.email : undefined,
      role: parsed.role as BridgeActor["role"],
    };
  } catch {
    return null;
  }
}

export function actorMayWrite(actor: BridgeActor): boolean {
  return actor.role === "admin" || actor.role === "clinician" || actor.role === "system";
}

export function actorIsAdmin(actor: BridgeActor): boolean {
  return actor.role === "admin" || actor.role === "system";
}
