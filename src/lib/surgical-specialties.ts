export type SurgicalSpecialty =
  | "orthopaedics_trauma"
  | "plastics"
  | "ent"
  | "maxfax"
  | "general"
  | "urology"
  | "gynaecology"
  | "other";

export const SURGICAL_SPECIALTY_LABEL: Record<SurgicalSpecialty, string> = {
  orthopaedics_trauma: "Orthopaedics / Trauma",
  plastics: "Plastics",
  ent: "ENT",
  maxfax: "Maxillofacial",
  general: "General surgery",
  urology: "Urology",
  gynaecology: "Gynaecology",
  other: "Other",
};

export const SURGICAL_SPECIALTY_OPTIONS: SurgicalSpecialty[] = [
  "orthopaedics_trauma",
  "plastics",
  "ent",
  "maxfax",
  "general",
  "urology",
  "gynaecology",
  "other",
];
