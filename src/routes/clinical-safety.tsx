import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/clinical-safety")({
  head: () => ({
    meta: [
      { title: "Clinical safety — SDH Critical Care" },
      {
        name: "description",
        content:
          "Clinical safety information for the SDH Critical Care referral tracker, including hazard reporting and the named Clinical Safety Officer.",
      },
      { property: "og:title", content: "Clinical safety — SDH Critical Care" },
      {
        property: "og:description",
        content:
          "Clinical safety information and hazard reporting for the SDH Critical Care referral tracker.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ClinicalSafetyPage,
});

function ClinicalSafetyPage() {
  return (
    <main id="main" className="min-h-screen bg-background px-4 py-10">
      <article className="mx-auto max-w-3xl prose prose-slate dark:prose-invert">
        <p className="text-sm text-muted-foreground">
          This page is maintained by Salisbury NHS Foundation Trust to provide clinical safety information about the SDH Critical Care referral tracker.
        </p>

        <h1>Clinical safety</h1>

        <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 not-prose">
          <h2 className="text-base font-semibold text-warning-foreground mb-1">
            Named Clinical Safety Officer — pending appointment
          </h2>
          <p className="text-sm text-foreground">
            Salisbury NHS Foundation Trust is in the process of appointing a Named Clinical Safety Officer for this digital service. Once appointed, their name, professional registration number, and contact details will be published here.
          </p>
        </div>

        <h2>Reporting a safety concern</h2>
        <p>
          If you believe this system has contributed to, or could contribute to, patient harm, please report it immediately through your trust’s incident-reporting system (e.g., Datix / Ulysses / local equivalent).
        </p>
        <p>
          In addition, email{" "}
          <a href="mailto:clinicalsafety@sdh-criticalcare.nhs.uk">clinicalsafety@sdh-criticalcare.nhs.uk</a>{" "}
          with:
        </p>
        <ul>
          <li>A description of the safety concern and any patient impact.</li>
          <li>Steps to reproduce or the circumstances in which it occurred.</li>
          <li>Your contact details and preferred urgency.</li>
        </ul>

        <h2>Hazard log</h2>
        <p>
          A clinical hazard log is being developed as part of the DCB0129 clinical safety case. It will be published here once the Named Clinical Safety Officer has reviewed and approved it.
        </p>

        <h2>Known issues and field safety notices</h2>
        <p>
          There are no active field safety notices for this service at present. When a known issue is identified that may affect patient safety, it will be posted here with mitigations and a resolution timeline.
        </p>

        <h2>What we do to reduce risk</h2>
        <ul>
          <li>End-to-end encryption of clinical notes to prevent unauthorised disclosure.</li>
          <li>Row-level security and role-based access control to ensure staff only see records relevant to their duties.</li>
          <li>Automatic session timeout to reduce the risk of unauthorised access on unattended devices.</li>
          <li>Append-only audit logging for patient-safety investigation.</li>
          <li>Password breach checking against known-compromised credentials.</li>
        </ul>

        <p className="text-sm text-muted-foreground">
          Last reviewed: {new Date().toISOString().slice(0, 10)}. See also our{" "}
          <Link to="/security">security disclosure</Link> and{" "}
          <Link to="/privacy">privacy notice</Link> pages.
        </p>
      </article>
    </main>
  );
}
