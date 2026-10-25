# Landing direction contract

## Surface and mode

- `/` is an editorial dossier: help a person understand an authorized review, its evidence and limits, then choose a next step in Gotchu.
- Keep the product real and evidence-led. Do not invent results, customers, guarantees or a guided tour.

## Visual authority

- `DESIGN.md` is authoritative. The shipped direction is an editorial dossier layout with living dot fields; no sidebar index, section kickers or section numerals.
- Use expanded Saira for display and Saira text for reading. The light ground is pure `#ffffff` with graphite ink; dark is pure `#000000` with porcelain ink. Keep brand magenta and silver unchanged; offer light, dark and system.
- Restyle shadcn/ui controls on Base UI (base-nova): 8px buttons, 34px mobile controls and 48px desktop primary buttons, with a hard magenta offset on hover.
- The header is 52px desktop / 48px mobile, tucks on downward scroll and keeps its mobile menu attached to the header.
- Use type and living dot fields. No photos, realistic objects, 3D or helper/meta captions.

## Content

- The sequence is Mirada (hero), Repositorio (animated GitHub audit diagram), Web (animated external audit diagram), Preguntas (shadcn accordion) and Cierre (question, “we Gotchu.”, the dot GOTCHU wordmark, “Crea tu cuenta” and “Ya tengo cuenta”).
- Only the main audits get a diagram; do not list every feature. Diagrams show how an audit runs, never results. Every audit ends in an action to `/registro`.
- Show the real report JSON keys: `id`, `organizationId`, `applicationId`, `jobId`, `applicationName`, `mode`, `startedAt`, `finishedAt`, `internal`, `external`, `comparison`, `limitations`, `responseMode`, `actionsPerformed`, `version` and `revision`.
- Re-checks run every 1–24 hours only when the customer enables them. They are not real time; alerts stay inside Gotchu, and an alert never confirms an attack. Signed runtime telemetry feeds triage, not proof of compromise.
- Source analysis is bounded to JS/TS, JSON, YAML and TOML, with Semgrep, Gitleaks, Trivy and OSV where configured. Source is not executed.
- HTTPS scope starts with DNS TXT proof of control, not legal ownership. The root profile makes one `GET /`; the public-surface profile makes up to ten GETs to that origin. TLS is verified; cookies, credentials and redirects are not used. Exploitability remains unknown; severity may be unevaluated.
- Some findings can produce a private corrected copy and independent re-analysis. Neither changes the repository or production. After the Owner approves the exact change with a passkey, the independent executor can open a draft PR in a linked GitHub repository.

## Signature moment

- The hero pairs a large uppercase headline with a living dot-field mark. Lines reveal; the field follows and ripples from the pointer, gathers on `data-catch` actions, and can be paused.
- Carry the dot language through the hero mark and the closing wordmark.

## Boundaries

- Never claim customer-code execution, PRs without exact approval, merging, deployment, rollback, automatic response, provider recovery, external notifications, AI investigation, AWS hosting or guaranteed security.
- The public landing should describe only the product boundaries below. Do not restyle `/dashboard` or `/demo`, broaden authorization, or turn a visual reference into a product promise.

## Voice

- Use short two-beat statements, followed by one human sentence that explains the limit or next step.
- Hero: **“Mira de cerca. Decide con pruebas.”**
- Prefer concrete Spanish and product vocabulary. No captions that explain the artwork or the page.
