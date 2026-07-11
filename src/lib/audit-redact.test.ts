import { describe, it, expect } from "vitest";
import { redactAuditDiff } from "./audit-redact";

describe("redactAuditDiff", () => {
  it("drops keys with crypto suffixes (_enc, _ciphertext, _nonce, _hash)", () => {
    const out = redactAuditDiff({
      hospital_number_enc: "v1:AAAA…",
      hospital_number_hash: "abcd1234",
      body_ciphertext: "…",
      body_nonce: "…",
      status: "pending",
    });
    expect(out).toEqual({ status: "pending" });
  });

  it("replaces known-sensitive plaintext values with [encrypted]", () => {
    const out = redactAuditDiff({
      hospital_number: "H12345",
      reason_for_referral: "Sepsis, requires ITU",
      past_medical_history: "COPD, HTN",
      status: "accepted",
    });
    expect(out).toEqual({
      hospital_number: "[encrypted]",
      reason_for_referral: "[encrypted]",
      past_medical_history: "[encrypted]",
      status: "accepted",
    });
  });

  it("redacts both branches of an { old, new } diff, preserving nulls", () => {
    const out = redactAuditDiff({
      reason_for_referral: { old: "prev reason", new: "new reason" },
      past_medical_history: { old: null, new: "COPD" },
      status: { old: "pending", new: "accepted" },
    });
    expect(out).toEqual({
      reason_for_referral: { old: "[encrypted]", new: "[encrypted]" },
      past_medical_history: { old: null, new: "[encrypted]" },
      status: { old: "pending", new: "accepted" },
    });
  });

  it("recurses into nested objects and arrays", () => {
    const out = redactAuditDiff({
      changes: [
        { hospital_number_enc: "x", note: "safe" },
        { body: "secret note body" },
      ],
      wrapper: { patient_initials: "AB", meta: { deleted: false } },
    });
    expect(out).toEqual({
      changes: [{ note: "safe" }, { body: "[encrypted]" }],
      wrapper: { patient_initials: "[encrypted]", meta: { deleted: false } },
    });
  });

  it("passes through null / primitive diffs unchanged", () => {
    expect(redactAuditDiff(null)).toBeNull();
    expect(redactAuditDiff(42)).toBe(42);
    expect(redactAuditDiff("ok")).toBe("ok");
  });

  // Regression guard: the redactor must remain suffix-driven, not
  // allowlist-driven, for crypto columns. Any future encrypted column
  // added to the schema — long after this test was written — should be
  // dropped automatically as long as it follows the `*_enc`,
  // `*_ciphertext`, `*_nonce`, or `*_hash` naming convention. If someone
  // rewrites the redactor around a fixed list of known columns, this
  // test fails and forces them to preserve the fallback.
  it("drops NEW encrypted columns not in any allowlist, purely by crypto suffix", () => {
    const out = redactAuditDiff({
      // Fabricated columns that don't exist today; they must still be
      // stripped because their names end in a crypto suffix.
      future_column_enc: "v2:ZZZZ…",
      brand_new_field_ciphertext: "…lots of base64…",
      unseen_thing_nonce: "IV-BYTES",
      totally_unknown_hash: "sha256:deadbeef",
      // Nested inside an { old, new } diff — both branches must lose
      // the suffix keys too.
      diff: {
        old: { experimental_secret_enc: "OLD", other: "keep" },
        new: { experimental_secret_enc: "NEW", other: "keep2" },
      },
      // Inside an array — same rule.
      history: [
        { unmapped_pii_hash: "abc", label: "row1" },
        { some_new_col_nonce: "xyz", label: "row2" },
      ],
      // Untouched key stays as-is.
      status: "pending",
    });

    expect(out).toEqual({
      diff: {
        old: { other: "keep" },
        new: { other: "keep2" },
      },
      history: [{ label: "row1" }, { label: "row2" }],
      status: "pending",
    });
  });

  it("passes through null / primitive diffs unchanged", () => {
    expect(redactAuditDiff(null)).toBeNull();
    expect(redactAuditDiff(42)).toBe(42);
    expect(redactAuditDiff("ok")).toBe("ok");
  });

  // Regression: pathological deep nesting with mixed arrays and objects,
  // { old, new } diffs buried several layers down, sensitive plaintext
  // co-located with crypto-suffix siblings, and fabricated future keys —
  // every matching column MUST be scrubbed at every depth. Iterating
  // separately (rather than a single toEqual) makes any depth-specific
  // regression point at the exact path that leaked.
  it("recursively redacts every matching column at arbitrary depth in mixed arrays/objects", () => {
    const input = {
      status: "pending",
      hospital_number: "H1",
      hospital_number_enc: "v1:CIPHER",
      audit: {
        wrapper: {
          past_medical_history: "COPD",
          past_medical_history_enc: "v1:PMH",
          history: [
            {
              patient_initials: "AB",
              body: { old: "old body", new: "new body" },
              nested: {
                reason_for_referral: { old: "sepsis", new: "shock" },
                totally_new_hash: "sha256:zzz",
                deeper: [
                  {
                    body_ciphertext: "…",
                    body_nonce: "IV",
                    body: "leaf plaintext body",
                    label: "leaf-A",
                  },
                  "raw-string-leaf",
                  42,
                  null,
                ],
              },
            },
            {
              proposed_procedure: { old: "laparotomy", new: null },
              future_column_enc: "v2:ZZZZ",
              safe: "keep",
            },
          ],
        },
        // Sensitive plaintext key holding a non-diff object value — must
        // be redacted wholesale, not traversed in a way that leaks sub-fields.
        allergies: { severity: "high", detail: "penicillin" },
      },
      matrix: [
        [
          { hospital_number: "H2", label: "m0" },
          { unmapped_pii_hash: "abc", label: "m1" },
        ],
        [
          {
            wrapper: {
              inner: {
                reason_for_bed: "ITU pressure",
                brand_new_field_ciphertext: "…",
                nested_again: [
                  {
                    dnacpr_details: "confidential",
                    tep_details: { old: "escalate", new: "ward-based" },
                    unseen_nonce: "IV",
                    keep: true,
                  },
                ],
              },
            },
          },
        ],
      ],
    };

    const out = redactAuditDiff(input) as any;

    // Top level
    expect(out.status).toBe("pending");
    expect(out.hospital_number).toBe("[encrypted]");
    expect(out).not.toHaveProperty("hospital_number_enc");

    // Depth 2
    expect(out.audit.wrapper.past_medical_history).toBe("[encrypted]");
    expect(out.audit.wrapper).not.toHaveProperty("past_medical_history_enc");

    // Depth 3
    const h0 = out.audit.wrapper.history[0];
    expect(h0.patient_initials).toBe("[encrypted]");
    expect(h0.body).toEqual({ old: "[encrypted]", new: "[encrypted]" });

    // Depth 4
    expect(h0.nested.reason_for_referral).toEqual({
      old: "[encrypted]",
      new: "[encrypted]",
    });
    expect(h0.nested).not.toHaveProperty("totally_new_hash");

    // Depth 5: leaf inside array-in-object-in-array-in-object
    const leafA = h0.nested.deeper[0];
    expect(leafA.body).toBe("[encrypted]");
    expect(leafA).not.toHaveProperty("body_ciphertext");
    expect(leafA).not.toHaveProperty("body_nonce");
    expect(leafA.label).toBe("leaf-A");

    // Primitive leaves in the same array survive verbatim.
    expect(h0.nested.deeper[1]).toBe("raw-string-leaf");
    expect(h0.nested.deeper[2]).toBe(42);
    expect(h0.nested.deeper[3]).toBeNull();

    // { old, new } with a null branch keeps the null.
    const h1 = out.audit.wrapper.history[1];
    expect(h1.proposed_procedure).toEqual({ old: "[encrypted]", new: null });
    expect(h1).not.toHaveProperty("future_column_enc");
    expect(h1.safe).toBe("keep");

    // Sensitive key with non-diff object value — redacted wholesale.
    expect(out.audit.allergies).toBe("[encrypted]");
    expect(JSON.stringify(out.audit.allergies)).not.toContain("penicillin");

    // Deep mixed matrix
    expect(out.matrix[0][0].hospital_number).toBe("[encrypted]");
    expect(out.matrix[0][0].label).toBe("m0");
    expect(out.matrix[0][1]).not.toHaveProperty("unmapped_pii_hash");
    expect(out.matrix[0][1].label).toBe("m1");

    const deepInner = out.matrix[1][0].wrapper.inner;
    expect(deepInner.reason_for_bed).toBe("[encrypted]");
    expect(deepInner).not.toHaveProperty("brand_new_field_ciphertext");
    const deepestLeaf = deepInner.nested_again[0];
    expect(deepestLeaf.dnacpr_details).toBe("[encrypted]");
    expect(deepestLeaf.tep_details).toEqual({
      old: "[encrypted]",
      new: "[encrypted]",
    });
    expect(deepestLeaf).not.toHaveProperty("unseen_nonce");
    expect(deepestLeaf.keep).toBe(true);

    // Global sweep: no forbidden markers, no crypto-suffix keys at ANY depth.
    const serialised = JSON.stringify(out);
    const forbiddenMarkers = [
      "v1:CIPHER",
      "v2:ZZZZ",
      "sha256:zzz",
      "penicillin",
      "leaf plaintext body",
      "COPD",
      "sepsis",
      "shock",
      "H1",
      "H2",
      "ITU pressure",
      "confidential",
      "escalate",
      "ward-based",
      "laparotomy",
      "old body",
      "new body",
    ];
    for (const m of forbiddenMarkers) {
      expect(serialised.includes(m), `leaked marker "${m}"`).toBe(false);
    }
    for (const suffix of ["_enc", "_ciphertext", "_nonce", "_hash"]) {
      const keyPattern = new RegExp(`"[A-Za-z0-9_]+${suffix}"\\s*:`);
      expect(
        keyPattern.test(serialised),
        `crypto-suffix key ending in ${suffix} survived`,
      ).toBe(false);
    }
  });
});

