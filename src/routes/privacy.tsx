import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy notice — SDH Critical Care" },
      {
        name: "description",
        content:
          "Privacy notice for the SDH Critical Care referral tracker. How Salisbury NHS Foundation Trust processes personal data.",
      },
      { property: "og:title", content: "Privacy notice — SDH Critical Care" },
      {
        property: "og:description",
        content:
          "How Salisbury NHS Foundation Trust processes personal data in the critical care referral tracker.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <main id="main" className="min-h-dvh bg-background px-4 py-10">
      <article className="mx-auto max-w-3xl prose prose-slate dark:prose-invert">
        <p className="text-sm text-muted-foreground">
          This page is maintained by Salisbury NHS Foundation Trust to explain how the SDH Critical Care referral tracker processes personal data.
        </p>

        <h1>Privacy notice</h1>

        <h2>Data controller</h2>
        <p>
          <strong>Salisbury NHS Foundation Trust</strong> is the data controller for information processed by this application.
        </p>
        <p>
          <strong>Data Protection Officer (DPO):</strong> Contact details to be confirmed.
        </p>

        <h2>What data we collect and why</h2>
        <p>
          This referral tracker is used by critical care teams to manage patient referrals, post-operative bookings, and clinical handovers. The lawful basis for processing is the delivery of NHS healthcare (public task / performance of a contract).
        </p>
        <ul>
          <li><strong>Patient identifiers:</strong> NHS Number, hospital number, date of birth — to match referrals to the correct patient record.</li>
          <li><strong>Clinical notes:</strong> Reason for referral, clinical observations, and handover details — end-to-end encrypted so only authorised team members can read them.</li>
          <li><strong>Contact details:</strong> Name and professional email address of clinical staff — for access control, audit, and notifications.</li>
          <li><strong>Audit logs:</strong> Timestamps of who created, viewed, or changed a record — for patient-safety investigation and accountability.</li>
        </ul>

        <h2>How we protect your data</h2>
        <ul>
          <li>Row-level security prevents users from accessing records outside their authorised scope.</li>
          <li>Clinical notes are encrypted end-to-end with per-recipient keys; the platform cannot read them.</li>
          <li>Patient identifiers are encrypted at rest and indexed by salted hash only.</li>
          <li>All data in transit is protected by TLS 1.2 or higher.</li>
          <li>Sessions end automatically after a period of inactivity.</li>
        </ul>

        <h2>Cookies and tracking</h2>
        <p>
          We do not use third-party analytics or advertising cookies. We set only essential authentication and session cookies (or equivalent localStorage items) required to keep you signed in securely.
        </p>

        <h2>Data retention</h2>
        <p>
          Referrals, clinical notes, and audit logs are retained for <strong>10 years</strong> from the date of creation, after which they are securely purged. This aligns with NHS record-retention standards for critical care.
        </p>

        <h2>Your rights</h2>
        <p>
          Under UK GDPR and the Data Protection Act 2018, you have the right to:
        </p>
        <ul>
          <li>Request access to your personal data (subject access request).</li>
          <li>Ask for incorrect data to be corrected.</li>
          <li>Request erasure in certain circumstances.</li>
          <li>Restrict or object to processing.</li>
          <li>Make a complaint to the Information Commissioner’s Office (ICO).</li>
        </ul>
        <p>
          To exercise these rights, contact the Data Protection Officer using the details above.
        </p>

        <h2>Data protection impact assessment (DPIA) and record of processing (ROPA)</h2>
        <p>
          A DPIA and ROPA are being developed for this service. The evidence index is maintained in the project documentation at <code>docs/dtac/README.md</code>.
        </p>

        <h2>Changes to this notice</h2>
        <p>
          We may update this privacy notice as the service evolves or as regulations change. The latest version will always be available at this URL.
        </p>

        <p className="text-sm text-muted-foreground">
          Last updated: {new Date().toISOString().slice(0, 10)}. See also our{" "}
          <Link to="/security">security disclosure</Link> page and the{" "}
          <Link to="/clinical-safety">clinical safety</Link> page.
        </p>
      </article>
    </main>
  );
}
