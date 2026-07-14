import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/security-faq")({
  head: () => ({
    meta: [
      { title: "Security FAQ — SDH Critical Care" },
      {
        name: "description",
        content:
          "Frequently asked questions about security, row-level security, data protection, and access auditing for the SDH Critical Care referral tracker.",
      },
      { property: "og:title", content: "Security FAQ — SDH Critical Care" },
      {
        property: "og:description",
        content:
          "Security FAQ for the SDH Critical Care referral tracker: fail-closed RLS, protected data, and access auditing.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SecurityFaqPage,
});

function SecurityFaqPage() {
  return (
    <main id="main" className="min-h-dvh bg-background px-4 py-10">
      <article className="mx-auto max-w-3xl prose prose-slate dark:prose-invert">
        <p className="text-sm text-muted-foreground">
          This page is maintained by Salisbury NHS Foundation Trust to answer
          common security questions about the SDH Critical Care referral tracker.
        </p>

        <h1>Security FAQ</h1>

        <h2>What does “fail-closed” mean for this service?</h2>
        <p>
          Every database request starts with a default answer of <strong>deny</strong>.
          Row-Level Security (RLS) policies then allow access only when the
          signed-in user explicitly meets the rules for that record. If a
          policy is missing, incomplete, or the user is not authenticated, the
          data is not returned.
        </p>

        <h2>What is protected by Row-Level Security?</h2>
        <p>
          All patient-related data is protected by RLS, including:
        </p>
        <ul>
          <li>Referrals and referral decisions.</li>
          <li>Bed occupancy and patient acuity information.</li>
          <li>Post-operative bookings.</li>
          <li>Clinical notes and handover details.</li>
          <li>Audit logs and access-control records.</li>
          <li>Staff profile and role information.</li>
        </ul>

        <h2>How is clinical data protected in addition to RLS?</h2>
        <p>
          Clinical notes are end-to-end encrypted with per-recipient keys, so the
          platform itself cannot read them. Patient identifiers are encrypted at
          rest and are indexed by salted hash only. All data in transit is
          protected by TLS.
        </p>

        <h2>How is access audited?</h2>
        <p>
          Privileged actions are written to an append-only audit trail. We also
          rate-limit sign-in attempts, password resets, and encryption unlock
          attempts to reduce the risk of unauthorised access. Signed-in sessions
          end automatically after a period of inactivity.
        </p>

        <h2>Who decides whether a user can see a record?</h2>
        <p>
          Access is governed by RLS policies tied to the authenticated user’s
          identity and assigned role. A user must be both signed in and explicitly
          authorised to read, create, or modify a record.
        </p>

        <h2>How do you report a security issue?</h2>
        <p>
          Email{" "}
          <a href="mailto:security@sdh-criticalcare.nhs.uk">
            security@sdh-criticalcare.nhs.uk
          </a>{" "}
          with the details. Our{" "}
          <Link to="/security">security disclosure</Link> page explains the
          scope, safe-harbour terms, and response timelines.
        </p>

        <h2>How is the platform kept up to date?</h2>
        <p>
          Dependencies are scanned for known vulnerabilities on every build, and
          server-side code runs in a hardened environment with no direct database
          access outside the RLS policies.
        </p>

        <p className="text-sm text-muted-foreground">
          Last updated: {new Date().toISOString().slice(0, 10)}. See also our{" "}
          <Link to="/security">security disclosure</Link> page and{" "}
          <Link to="/privacy">privacy notice</Link>.
        </p>
      </article>
    </main>
  );
}
