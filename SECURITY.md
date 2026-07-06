# Security policy — SDH Critical Care

This service handles NHS patient data and is deployed under the UK NHS
Digital Technology Assessment Criteria (DTAC). We welcome coordinated
disclosure of security issues.

## Reporting a vulnerability

Email **security@sdh-criticalcare.nhs.uk** with reproduction steps,
impact, and how you'd like to be credited.

- Acknowledgement: within 2 working days
- Triage: within 5 working days
- Remediation targets: Critical 7 days, High 30 days, Medium 90 days

## Scope

- The web application and its server functions
- Public API endpoints under `/api/public/*`
- The end-to-end encryption model used for clinical notes

## Out of scope

- Social engineering of staff or patients
- Physical attacks on hospital infrastructure
- Denial-of-service testing against production
- Third-party services we depend on (report to the vendor)

## Safe harbour

Good-faith research within the scope above will not lead to legal action.
Please give us reasonable time to remediate before public disclosure.

## Controls in place

See `docs/SECURE_DEVELOPMENT.md` and the public
[security page](https://critical-care-flow.lovable.app/security).
