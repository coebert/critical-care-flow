// Server-only crypto helpers for post-op bookings.
//
// Kept in a *.server.ts file (and loaded via dynamic import from server
// function handlers only) so the Node "crypto" module never leaks into the
// client bundle via the postop-bookings.functions.ts module graph.

import { encryptString, decryptString, hashHospitalNumber } from "./crypto.server";

export const ENC_FIELDS = [
  "proposed_procedure",
  "past_medical_history",
  "past_surgical_history",
  "social_history",
  "reason_for_bed",
] as const;

export function encryptPayload(input: Record<string, any>) {
  const out: Record<string, unknown> = {
    age: input.age ?? null,
    sex: input.sex ?? null,
    weight_kg: input.weight_kg ?? null,
    height_cm: input.height_cm ?? null,
    bmi: input.bmi ?? null,
    predicted_level: input.predicted_level,
    proposed_surgery_date: input.proposed_surgery_date ?? null,
    arrived_at: input.arrived_at ?? null,
    surgical_specialty: input.surgical_specialty ?? null,
    is_test: input.is_test ?? false,
    hospital_number_enc: encryptString(input.hospital_number ?? null),
    hospital_number_hash: hashHospitalNumber(input.hospital_number ?? null),
  };
  for (const k of ENC_FIELDS) {
    out[`${k}_enc`] = encryptString(input[k] ?? null);
  }
  return out;
}

export function decryptRow(row: Record<string, any>) {
  const out: Record<string, any> = { ...row };
  out.hospital_number = decryptString(row.hospital_number_enc ?? null);
  for (const k of ENC_FIELDS) {
    out[k] = decryptString(row[`${k}_enc`] ?? null);
    delete out[`${k}_enc`];
  }
  delete out.hospital_number_enc;
  delete out.hospital_number_hash;
  return out;
}
