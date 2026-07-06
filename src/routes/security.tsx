import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/security")({
  head: () => ({
    meta: [
      { title: "Security & vulnerability disclosure — SDH Critical Care" },
      {
        name: "description",
        content:
          "How to report a security vulnerability in the SDH Critical Care referral tracker. Coordinated disclosure contact, scope, and safe-harbour statement.",
      },
      { property: "og:title", content: "Security & vulnerability disclosure — SDH Critical Care" },
      {
        property: "og:description",
        content:
          "Coordinated vulnerability disclosure policy for the SDH Critical Care referral tracker.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SecurityPage,
});

function SecurityPage() {
  return (
    <main id="main" className="min-h-screen bg-background px-4 py-10">
      <article className="mx-auto max-w-3xl prose prose-slate dark:prose-invert">
        <h1>Security &amp; vulnerability disclosure</h1>
        <p className="lead">
          We take security seriously. This service handles NHS patient data and
          is deployed under UK NHS Digital Technology Assessment Criteria
          (DTAC). If you believe you have found a security vulnerability, please
          tell us so we can fix it before it is exploited.
        </p>

        <h2>How to report</h2>
        <p>
          Email <a href="mailto:security@sdh-criticalcare.nhs.uk">security@sdh-criticalcare.nhs.uk</a>{" "}
          with:
        </p>
        <ul>
          <li>A description of the issue and its potential impact.</li>
          <li>Steps to reproduce (URLs, payloads, screenshots).</li>
          <li>Your name and how you&rsquo;d like to be credited (optional).</li>
        </ul>
        <p>
          We aim to acknowledge reports within <strong>2 working days</strong>,
          triage within <strong>5 working days</strong>, and remediate confirmed
          issues within timelines proportionate to severity (Critical: 7 days,
          High: 30 days, Medium: 90 days).
        </p>

        <h2>Scope</h2>
        <ul>
          <li>The web application at this domain.</li>
          <li>Its supporting server functions and public API endpoints.</li>
          <li>The end-to-end encryption implementation used for clinical notes.</li>
        </ul>

        <h2>Out of scope</h2>
        <ul>
          <li>Social engineering of staff or patients.</li>
          <li>Physical attacks on hospital infrastructure.</li>
          <li>Denial-of-service testing against production.</li>
          <li>
            Third-party services we depend on (report those to the relevant
            vendor directly).
          </li>
        </ul>

        <h2>Safe harbour</h2>
        <p>
          Provided you act in good faith, avoid privacy violations and
          destruction of data, stay within the scope above, and give us
          reasonable time to remediate before disclosure, we will not pursue
          legal action for your research.
        </p>

        <h2>What we do</h2>
        <ul>
          <li>Enforce row-level security on every data table.</li>
          <li>End-to-end encrypt clinical notes with per-recipient keys.</li>
          <li>Encrypt patient identifiers at rest and index them by salted hash only.</li>
          <li>Rate-limit sign-in, password reset and encryption unlock attempts.</li>
          <li>Sign users out automatically after inactivity.</li>
          <li>Log privileged actions to an append-only audit trail.</li>
          <li>Scan dependencies for known vulnerabilities on every build.</li>
        </ul>

        <p className="text-sm text-muted-foreground">
          Last reviewed: {new Date().toISOString().slice(0, 10)}. See also our{" "}
          <Link to="/">home page</Link> and the project&rsquo;s public{" "}
          <code>SECURITY.md</code>.
        </p>
      </article>
    </main>
  );
}
