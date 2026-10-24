# Landing validation

Scope: public `/` and local design context only. Customer/demo presentation, backend, permissions and authentication are unchanged.

## Sources and editorial review

- Product claims checked against `packages/contracts/src/assessment.ts` (severity, confidence and coverage enums, `responseMode: 'observation'`, empty `actionsPerformed`), `customer-dashboard.tsx` and `docs/architecture.md`.
- Copy distinguishes source snapshots, explicitly authorized HTTPS and combined evidence. No monitoring, automatic fixes, whole-site crawl, execution of uploaded code or guaranteed security is advertised.
- The landing ships no raster or SVG artwork files; the mark, ASCII render, pictograms and grid are authored in components. No reference-site assets, AIRNT or loader are included. Saira ships with its OFL license.
- No artwork explanations, mock-analysis captions, invented scanner results, metrics or testimonials.

## Verification exercised

- Web typecheck, 48 web unit tests and the production web build passed.
- Playwright: 16 desktop/mobile cases passed, 2 skipped by design (pointer following and the pinned stage are desktop-only). Cases cover axe WCAG 2.2 AA, canvas redraw on pointer move and on primary-action hover, the GOTCHU wipe and report panel, chapters, ARIA tabs with pointer/keyboard, menu/Escape, FAQ, CTA destinations, reduced motion at 320px and no-JavaScript content.
- Impeccable detector: no quality antipatterns on the landing components.
- Impeccable finish review: two full rounds plus verdict passes; final disposition `ship` for the scored fixes (kickers, FAQ face, flash takeover and wipe, settled stage frame, workflow and journey pictogram scale, closing line break, contract seed). Renders are in `screenshots/`.

## Remaining limits

- `review-animations` (Emil Kowalski) is user-invoked and was not run.
- The translucent header reads plum over magenta fields; noted by the reviewer as pre-existing, not changed.
- `tokens.css` still carries retired tokens used by `ui.css` (Oxanium face, 4/6px radii, status colours).
- Chromium coverage is local; no Safari/Firefox matrix, real-device GPU benchmark or deployment claim is made.
- Commercial AIRNT licensing and buyer-specialization research remain open.
