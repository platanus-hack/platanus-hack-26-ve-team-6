# Gotchu

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People maintaining a business application who need to understand security observations and decide what to inspect next; technical operators read the underlying evidence. This audience is inferred from Jenn's brief and the existing application, not a completed buyer-research study.

## Product Purpose

Assess explicitly authorized source snapshots and HTTPS origins. Retain evidence-backed reports and distinguish observations, confidence, exploitability and unknown coverage. Help a person decide what to review without presenting a limited assessment as a security guarantee.

## Operating Context

The current main baseline (26162b7, including PR 25) supports authentication, workspaces, applications, HTTPS-first onboarding, optional GitHub connections, source snapshots, live assessment phases, project summaries, report evidence and copyable finding prompts, periodic re-checks, signed runtime-event triage, email/webhook notifications, optional model investigations/private AI corrections and exactly approved draft PRs. A gated controlled-demo dashboard compares known fixture revisions. Assessments are observational; private correction and approved PR workflows have separate authorization. Repository documentation remains authoritative for authorization and backend capabilities.

## Capabilities and Constraints

TanStack Start, React, Auth.js, pnpm, Node 24 and strict TypeScript are established repository choices. Preserve HTTP/worker/provider boundaries, tenant isolation and authorization. Static assessment does not execute customer code. Separate candidate validation requires its configured isolated runner gate. Severity does not grant permissions. Scheduled re-checks run every 1–24 hours when enabled; they are periodic. Configured SMTP and signed HTTPS webhook channels provide durable notification delivery with retries and visible status. Reports do not confirm exploitation. Some findings can produce a private corrected snapshot and a queued independent re-analysis without changing the original source or production. Draft PRs require independent validation, repository publication consent and exact Owner-session approval; the customer flow has no second factor. Further product proposals belong in docs/roadmap.md. No mandatory paid identity, model or repository service.

**Current iteration: align the landing and product documentation with main and merged PR 25. Preserve implemented notifications, optional AI workflows and approved draft PRs. Consolidate future proposals in docs/roadmap.md; do not add product behavior.**

## Brand Commitments

Jenn's supplied cybersecurity prototype informs the palette: magenta #E7147D, graphite #191923, off-white #FFFEFA and silver #C7BFBD; futuristic, digital, professional typography and precise controls. Its composition and assets are not a template to reproduce. The public landing uses living dot fields, code and web audit sections with their benefits, and an editorial dossier layout with no photo-real or 3D artwork. The user supplied a brand board, firecrawl.dev and exa.ai as references for type, elements and feel; colours stay as above. The cream/coral Zcash editorial identity is a different project and is not applicable.

Gotchu is the repository/application name; the reference's earlier “Prototipo” label is not retained. AIRNT is a visual reference, not a licensed commercial web asset. Saira (OFL, variable width) is the self-hosted landing family: an expanded cut for display and the normal cut for text. AIRNT stays a visual reference only; do not distribute it without license evidence.

## Evidence on Hand

Jenn's supplied `prototipo.html` and its reviewed second iteration establish visual direction, not product capabilities. Existing contracts and workflows establish actual scope. No fabricated customers, testimonials, certifications, performance figures or security guarantees. Do not fabricate assessment results. Use authored assets and product-structure panels instead of invented records or pseudo-results, and omit meta/helper captions that explain the artwork or the page. The landing covers snapshot revisions/digests, requested HTTPS scope, evidence fields, coverage, workspace/application organization, queued-job history, JSON export, periodic re-checks, signed runtime events, configured email/webhook delivery, private corrected snapshots, optional AI and approved draft PRs.

## Product Principles

- Put evidence beside its limits.
- Require explicit scope before assessments; visual emphasis never expands authority.
- Keep the next step legible on a phone and at a desk.
- Use concrete Spanish; explain what a person can do rather than promise protection.

## Accessibility & Inclusion

Spanish interface with visible keyboard focus, semantic landmarks, native disclosure, readable contrast, controls at least 34px tall (above WCAG 2.2 AA's 24px target size) and reduced-motion support. Automated accessibility checks are evidence for tested states, not whole-product certification.

## Open Decisions

Primary buyer specialization and commercial AIRNT licensing remain open. The discovery interview timed out; the user then explicitly narrowed and authorized the landing-first iteration. AWS hosting and GitHub CI/CD were retired at the operator's request; infra/aws/README.md records the retirement. Runtime services and optional integrations must be configured per installation; implementation is not proof of hosted availability. Future scope is kept in docs/roadmap.md.
