# Gotchu

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Working hypothesis from the supplied prototype and existing workflows: people maintaining a business application who need to prioritize security observations, with technical operators reading the underlying evidence. The confirmation interview timed out; a narrower buyer persona remains open, not a confirmed market finding.

## Product Purpose

Assess explicitly authorized source snapshots and HTTPS origins, retain evidence-backed reports, and distinguish observations, confidence, exploitability and unknown coverage. Help a person decide what to inspect next without presenting a limited assessment as a security guarantee.

## Operating Context

The current customer dashboard supports authentication, workspaces, applications, DNS-based authorization, source snapshot upload, queued assessments, history and report evidence. A separately gated controlled-demo dashboard compares known fixture revisions. Both operate in observation mode. The repository documentation remains the authority for authorization and backend capabilities.

## Capabilities and Constraints

TanStack Start, React, Auth.js, pnpm, Node 24 and strict TypeScript are established repository choices. Keep HTTP/worker/provider boundaries, tenant isolation and authorization unchanged. Source is not executed. Severity does not grant permissions. Automated remediation and recovery are not implemented by this design work. No mandatory paid identity, model or repository service.

This PR implements reusable presentation primitives, tokens, a component catalogue and both existing dashboard themes. It does not add a public marketing landing, new backend capabilities or a production deployment.

## Brand Commitments

Use the supplied cybersecurity prototype as visual direction, including magenta #E7147D, graphite #191923, off-white #FFFEFA and silver #C7BFBD. Jenn requested a futuristic, digital, professional treatment with angular geometry and restrained controls. The unrelated cream/coral Zcash editorial identity is not applicable here.

Gotchu is the existing application/repository name. The prototype's earlier label “Prototipo” is treated as provisional pending confirmation, not a new approved product name. AIRNT was supplied as a visual reference only; the trial is not a commercial web license. Do not distribute or embed it in the application without license evidence.

## Evidence on Hand

User-supplied prototype: historical attachment `doc_b14c083285cc_prototipo.html`; local artifact in `.hermes/artifacts/prototipo-v2/`. Its composition is a reference, not evidence of implemented remediation. Existing customer and controlled-demo workflows provide implemented content. No fabricated customers, testimonials, security guarantees or uptime metrics.

## Product Principles

- Show the evidence and its limits together.
- Ask for explicit scope before assessments; visual emphasis never expands authority.
- Keep primary tasks legible on a phone and at a desk.
- Preserve context when an operation fails; explain recovery in the interface.

## Accessibility & Inclusion

Spanish interface. Target WCAG 2.2 AA contrast, visible keyboard focus, native controls and semantic disclosure. Reduced motion must not hide work status. Accessibility checks in this PR cover the tested surfaces, not whole-product certification.

## Open Decisions

Primary buyer specialization, commercial AIRNT license and a future public landing are not settled. The init interview was attempted in this session and timed out; implementation proceeds from the explicit brief and existing product rather than inventing answers.
