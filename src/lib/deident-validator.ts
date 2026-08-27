/**
 * Pre-upload de-identification validator.
 *
 * Every chart-scan payload MUST pass `assertDeidentified()` before any request
 * is sent to Google Gemini (or any other external AI processor). This encodes
 * the anonymisation rules asserted in the IG/IT proposal:
 *
 *   1. Only image/PDF chart scans of an allowed type and size may be sent.
 *   2. The binary must carry no embedded metadata (EXIF / XMP / PNG text
 *      chunks / PDF document-info) — those routinely contain device, GPS,
 *      author or patient-name fields.
 *   3. No direct identifier may appear anywhere in the accompanying prompt,
 *      filename, or structured metadata: NHS number, hospital/MRN number,
 *      full name, date of birth, any calendar date, postcode, phone number,
 *      email address, or free-text notes.
 *   4. Only the agreed minimal context fields may travel with the image:
 *      age band, sex, and (optionally) specialty.
 *
 * The validator is deliberately fail-closed: anything it cannot positively
 * classify as safe is a violation.
 */

export type DeidentSeverity = "block";

export interface DeidentViolation {
  /** Stable machine-readable code, safe to log and audit. */
  code: string;
  /** Where the problem was found: "image", "prompt", "filename", "metadata". */
  field: string;
  /** Human-readable explanation. Never contains the offending value. */
  message: string;
  severity: DeidentSeverity;
}

export interface ChartScanPayload {
  /** Raw image/PDF bytes about to be base64-encoded and uploaded. */
  bytes: Uint8Array;
  mimeType: string;
  /** Original filename, if any — often leaks names/hospital numbers. */
  filename?: string | null;
  /** Instruction text sent alongside the image. */
  prompt?: string | null;
  /** Minimal structured context permitted to accompany the scan. */
  metadata?: Record<string, unknown> | null;
}

export interface DeidentResult {
  ok: boolean;
  violations: DeidentViolation[];
}

export const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

/** 15 MB — comfortably above a full-page chart scan, below the API limit. */
export const MAX_PAYLOAD_BYTES = 15 * 1024 * 1024;

/** The only structured fields allowed to accompany a chart scan. */
export const ALLOWED_METADATA_KEYS = ["age_band", "sex", "specialty"] as const;

const ALLOWED_SEX = new Set(["M", "F", "O", "U"]);
const AGE_BAND = /^(?:1[6-9]|[2-8]\d)-(?:1[6-9]|[2-9]\d)$|^90\+$/;

// ---------------------------------------------------------------------------
// Text detectors
// ---------------------------------------------------------------------------

interface Detector {
  code: string;
  message: string;
  test: (text: string) => boolean;
}

const nhsNumberLike = (text: string): boolean => {
  const m = text.match(/\b\d[\d\s-]{8,13}\d\b/g);
  if (!m) return false;
  return m.some((candidate) => candidate.replace(/\D/g, "").length === 10);
};

const TEXT_DETECTORS: Detector[] = [
  {
    code: "nhs_number",
    message: "Looks like an NHS number (10 digits).",
    test: nhsNumberLike,
  },
  {
    code: "hospital_number",
    message: "Looks like a hospital number / MRN.",
    test: (t) =>
      /\b(?:mrn|hosp(?:ital)?\s*(?:no|num|number|#)|rxc|unit\s*number)\b[:\s#-]*[A-Z0-9-]{4,}/i.test(t) ||
      /\b[A-Z]{1,3}\d{6,10}\b/.test(t),
  },
  {
    code: "date_of_birth",
    message: "Contains a date of birth reference.",
    test: (t) => /\b(?:d\.?o\.?b\.?|date\s+of\s+birth|born)\b/i.test(t),
  },
  {
    code: "calendar_date",
    message: "Contains a calendar date; dates can re-identify a patient.",
    test: (t) =>
      /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/.test(t) ||
      /\b\d{4}-\d{2}-\d{2}\b/.test(t) ||
      /\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}\b/i.test(t),
  },
  {
    code: "uk_postcode",
    message: "Contains a UK postcode.",
    test: (t) => /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i.test(t),
  },
  {
    code: "phone_number",
    message: "Contains a telephone number.",
    test: (t) => /\b(?:\+44\s?\d[\d\s-]{8,}|0\d{3,4}[\s-]?\d{5,7})\b/.test(t),
  },
  {
    code: "email_address",
    message: "Contains an email address.",
    test: (t) => /[\w.+-]+@[\w-]+\.[\w.-]+/.test(t),
  },
  {
    code: "full_name",
    message: "Looks like a person's full name.",
    test: (t) =>
      /\b(?:mr|mrs|ms|miss|dr|prof|sr|master)\.?\s+[A-Z][a-z]+/.test(t) ||
      /\b(?:patient|name|surname|forename)\s*(?:name)?\s*[:=]\s*[A-Z][a-z]+/i.test(t) ||
      /\b[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}\b/.test(t),
  },
];

/** Run every text detector over a single string field. */
export function scanText(field: string, text: string | null | undefined): DeidentViolation[] {
  if (!text) return [];
  const normalised = text.normalize("NFKC");
  return TEXT_DETECTORS.filter((d) => d.test(normalised)).map((d) => ({
    code: d.code,
    field,
    message: d.message,
    severity: "block" as const,
  }));
}

// ---------------------------------------------------------------------------
// Binary metadata detectors
// ---------------------------------------------------------------------------

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = "";
  for (let i = start; i < Math.min(start + length, bytes.length); i++) {
    out += String.fromCharCode(bytes[i]!);
  }
  return out;
}

function indexOfMarker(bytes: Uint8Array, marker: string, limit = bytes.length): number {
  const needle = Array.from(marker, (c) => c.charCodeAt(0));
  const end = Math.min(limit, bytes.length) - needle.length;
  outer: for (let i = 0; i <= end; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function isJpeg(b: Uint8Array) {
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8;
}
function isPng(b: Uint8Array) {
  return b.length > 8 && ascii(b, 1, 3) === "PNG";
}
function isWebp(b: Uint8Array) {
  return b.length > 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP";
}
function isPdf(b: Uint8Array) {
  return ascii(b, 0, 5) === "%PDF-";
}

/**
 * Detect embedded metadata that could carry identifiers (EXIF, XMP, IPTC,
 * PNG textual chunks, PDF document info). Returns violation codes only —
 * never the metadata content itself.
 */
export function scanBinaryMetadata(bytes: Uint8Array, mimeType: string): DeidentViolation[] {
  const v: DeidentViolation[] = [];
  const add = (code: string, message: string) =>
    v.push({ code, field: "image", message, severity: "block" });

  const magicOk =
    (mimeType === "image/jpeg" && isJpeg(bytes)) ||
    (mimeType === "image/png" && isPng(bytes)) ||
    (mimeType === "image/webp" && isWebp(bytes)) ||
    (mimeType === "application/pdf" && isPdf(bytes));
  if (!magicOk) {
    add("mime_mismatch", "File contents do not match the declared file type.");
    return v;
  }

  if (mimeType === "image/jpeg") {
    // APP1 (EXIF/XMP) and APP13 (IPTC) segments must have been stripped.
    for (let i = 2; i + 4 < bytes.length; ) {
      if (bytes[i] !== 0xff) break;
      const marker = bytes[i + 1]!;
      if (marker === 0xda || marker === 0xd9) break; // start of scan / EOI
      const len = (bytes[i + 2]! << 8) + bytes[i + 3]!;
      if (marker === 0xe1) add("exif_present", "JPEG still contains EXIF/XMP metadata.");
      if (marker === 0xed) add("iptc_present", "JPEG still contains IPTC metadata.");
      if (marker === 0xfe) add("comment_present", "JPEG still contains a comment segment.");
      if (len <= 0) break;
      i += 2 + len;
    }
  }

  if (mimeType === "image/png") {
    for (const chunk of ["tEXt", "iTXt", "zTXt", "eXIf"]) {
      if (indexOfMarker(bytes, chunk) !== -1) {
        add("png_metadata_present", "PNG still contains textual/EXIF chunks.");
        break;
      }
    }
  }

  if (mimeType === "image/webp") {
    if (indexOfMarker(bytes, "EXIF") !== -1 || indexOfMarker(bytes, "XMP ") !== -1) {
      add("webp_metadata_present", "WebP still contains EXIF/XMP chunks.");
    }
  }

  if (mimeType === "application/pdf") {
    if (indexOfMarker(bytes, "/Author") !== -1 || indexOfMarker(bytes, "/Title") !== -1) {
      add("pdf_docinfo_present", "PDF still contains document-info metadata.");
    }
    if (indexOfMarker(bytes, "<?xpacket") !== -1) {
      add("pdf_xmp_present", "PDF still contains XMP metadata.");
    }
  }

  return v;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function validateDeidentifiedChartScan(payload: ChartScanPayload): DeidentResult {
  const violations: DeidentViolation[] = [];
  const add = (code: string, field: string, message: string) =>
    violations.push({ code, field, message, severity: "block" });

  const { bytes, mimeType, filename, prompt, metadata } = payload;

  if (!bytes || bytes.length === 0) {
    add("empty_payload", "image", "No image data to upload.");
  }
  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType)) {
    add("mime_not_allowed", "image", `File type "${mimeType}" is not permitted.`);
  }
  if (bytes && bytes.length > MAX_PAYLOAD_BYTES) {
    add("payload_too_large", "image", "File exceeds the maximum permitted upload size.");
  }

  if (bytes?.length && (ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType)) {
    violations.push(...scanBinaryMetadata(bytes, mimeType));
  }

  // Filenames must be opaque — no original names.
  if (filename) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}\.(jpg|jpeg|png|webp|pdf)$/i.test(filename)) {
      add(
        "filename_not_opaque",
        "filename",
        "Filename must be an opaque identifier (letters, digits, - and _ only).",
      );
    }
    violations.push(...scanText("filename", filename));
  }

  violations.push(...scanText("prompt", prompt));

  if (metadata) {
    for (const [key, value] of Object.entries(metadata)) {
      if (!(ALLOWED_METADATA_KEYS as readonly string[]).includes(key)) {
        add("metadata_key_not_allowed", "metadata", `Field "${key}" may not be sent.`);
        continue;
      }
      if (typeof value !== "string") {
        add("metadata_value_invalid", "metadata", `Field "${key}" must be a short string.`);
        continue;
      }
      if (key === "sex" && !ALLOWED_SEX.has(value)) {
        add("metadata_value_invalid", "metadata", "Sex must be one of M, F, O, U.");
      }
      if (key === "age_band" && !AGE_BAND.test(value)) {
        add("metadata_value_invalid", "metadata", "Age must be a band (e.g. 60-69 or 90+).");
      }
      if (key === "specialty" && !/^[A-Za-z &/-]{2,40}$/.test(value)) {
        add("metadata_value_invalid", "metadata", "Specialty contains unexpected characters.");
      }
      violations.push(...scanText("metadata", value));
    }
  }

  // De-duplicate identical code+field pairs.
  const seen = new Set<string>();
  const unique = violations.filter((x) => {
    const k = `${x.code}:${x.field}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { ok: unique.length === 0, violations: unique };
}

export class DeidentificationError extends Error {
  constructor(public readonly violations: DeidentViolation[]) {
    super(
      `Upload blocked: chart scan failed de-identification checks (${violations
        .map((v) => v.code)
        .join(", ")}).`,
    );
    this.name = "DeidentificationError";
  }
}

/**
 * Fail-closed gate. Call immediately before building any Gemini request body.
 */
export function assertDeidentified(payload: ChartScanPayload): void {
  const result = validateDeidentifiedChartScan(payload);
  if (!result.ok) throw new DeidentificationError(result.violations);
}
