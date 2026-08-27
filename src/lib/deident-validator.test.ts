import { describe, it, expect } from "vitest";
import {
  assertDeidentified,
  DeidentificationError,
  validateDeidentifiedChartScan,
  scanText,
  MAX_PAYLOAD_BYTES,
} from "./deident-validator";

/** Minimal metadata-free JPEG: SOI + SOS + EOI. */
function cleanJpeg(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
}

/** JPEG carrying an APP1 (EXIF) segment. */
function exifJpeg(): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02,
    0xff, 0xd9,
  ]);
}

function pngBytes(extra: string = ""): Uint8Array {
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return new Uint8Array([...header, ...Array.from(extra, (c) => c.charCodeAt(0))]);
}

const base = {
  bytes: cleanJpeg(),
  mimeType: "image/jpeg",
  filename: "scan_01.jpg",
  prompt: "Summarise the observation chart trends.",
  metadata: { age_band: "60-69", sex: "F", specialty: "General Surgery" },
};

const codes = (p: Parameters<typeof validateDeidentifiedChartScan>[0]) =>
  validateDeidentifiedChartScan(p).violations.map((v) => v.code);

describe("de-identification validator", () => {
  it("accepts a clean payload", () => {
    expect(validateDeidentifiedChartScan(base)).toEqual({ ok: true, violations: [] });
  });

  it("blocks unsupported file types and mismatched magic bytes", () => {
    expect(codes({ ...base, mimeType: "image/gif" })).toContain("mime_not_allowed");
    expect(codes({ ...base, bytes: pngBytes(), mimeType: "image/jpeg" })).toContain("mime_mismatch");
  });

  it("blocks oversized and empty payloads", () => {
    expect(codes({ ...base, bytes: new Uint8Array(0) })).toContain("empty_payload");
    const big = new Uint8Array(MAX_PAYLOAD_BYTES + 1);
    big.set(cleanJpeg());
    expect(codes({ ...base, bytes: big })).toContain("payload_too_large");
  });

  it("blocks residual embedded metadata", () => {
    expect(codes({ ...base, bytes: exifJpeg() })).toContain("exif_present");
    expect(codes({ ...base, bytes: pngBytes("tEXtAuthor"), mimeType: "image/png" })).toContain(
      "png_metadata_present",
    );
  });

  it("blocks identifiers in the prompt", () => {
    expect(codes({ ...base, prompt: "Patient NHS number 943 476 5919" })).toContain("nhs_number");
    expect(codes({ ...base, prompt: "MRN: RXC1234567" })).toContain("hospital_number");
    expect(codes({ ...base, prompt: "DOB 12/04/1958" })).toEqual(
      expect.arrayContaining(["date_of_birth", "calendar_date"]),
    );
    expect(codes({ ...base, prompt: "Mr Robert Coe" })).toContain("full_name");
    expect(codes({ ...base, prompt: "lives at SP2 8BJ" })).toContain("uk_postcode");
    expect(codes({ ...base, prompt: "call 07700 900123" })).toContain("phone_number");
    expect(codes({ ...base, prompt: "email a.b@nhs.net" })).toContain("email_address");
  });

  it("blocks non-opaque filenames", () => {
    expect(codes({ ...base, filename: "Smith John chart.jpg" })).toContain("filename_not_opaque");
  });

  it("restricts structured metadata to the agreed minimal set", () => {
    expect(codes({ ...base, metadata: { hospital_number: "R123456" } })).toContain(
      "metadata_key_not_allowed",
    );
    expect(codes({ ...base, metadata: { ...base.metadata, age_band: "67" } })).toContain(
      "metadata_value_invalid",
    );
    expect(codes({ ...base, metadata: { ...base.metadata, sex: "female" } })).toContain(
      "metadata_value_invalid",
    );
  });

  it("scanText reports nothing for empty input", () => {
    expect(scanText("prompt", null)).toEqual([]);
  });

  it("assertDeidentified throws for unsafe payloads and passes clean ones", () => {
    expect(() => assertDeidentified(base)).not.toThrow();
    expect(() => assertDeidentified({ ...base, bytes: exifJpeg() })).toThrow(DeidentificationError);
  });
});
