# Landing direction contract

- **Surface and mode:** `/`, Persuade → Understand → Act. A person maintaining a real application should understand the three assessment modes and reach `/dashboard` without a fabricated result or forced tour.
- **Visual authority:** original evidence-lens world, graphite/magenta/porcelain. The earlier supplied site is a palette reference, not a layout or asset template. Apple and Churupitos are interaction studies only; no borrowed images, code or initial loader.
- **Content:** compare source and HTTPS observations with evidence; never claim ongoing monitoring, automated fixes, attack confirmation or complete coverage. User forbids explanatory artwork and mock-interface captions. Therefore do not fabricate an interface or report that needs one.
- **Signature moment:** a layered optical instrument responds to pointer input, then accompanies the desktop scroll story. Source and origin layers change relationship to explain separate perspectives. Touch and reduced motion keep a complete static presentation.
- **Boundaries:** only landing, local design context, reusable presentation helpers and tests. Customer/demo UI, backend, permissions, auth and all production deployment remain untouched.

## Motion decisions

| Location | Purpose | Frequency | Implementation |
| --- | --- | --- | --- |
| Hero group | Arrival / first-time orientation | Rare | Transform 8px and opacity .6→1, 600ms strong ease-out, 60ms stagger; immediately usable |
| Lens pointer response | Spatial consistency and first-visit delight | Rare marketing exploration | Two interruptible Motion springs, duration .4, bounce 0; ±6°/±4°; fine pointer only |
| Lens scroll story | Explain source/HTTPS/evidence relationship | Once per visit | Native sticky; chapter observer; 500ms transform retargeting and 300ms opacity; bounded 18px depth travel |
| Scope selection | Prevent abrupt change | Occasional | 200ms opacity crossfade for pointer; keyboard updates immediately |
| Press / hover | Immediate feedback | Frequent | .97 press scale, 160ms token ease; 2px hover lift only with fine pointer |
| FAQ | State indication | Occasional | 200ms native disclosure; static fallback and reduced-motion variant |

Rejected: moving paragraphs, perpetual lens rotation, animated invented metrics, page loader, custom cursor, magnetic buttons that move away from the pointer, full-screen parallax, scroll snapping and scroll hijacking. The object never obstructs the reading column or captures touch scrolling.

## Source and implementation map

- Original asset generator: `scripts/generate-landing-assets.py`.
- Three assets: `public/landing/evidence-lens.svg`, `source-snapshot.svg`, `https-origin.svg`.
- Spatial behavior: `src/components/evidence-lens.tsx`.
- Content and interaction: `src/components/landing.tsx`.
- Theme and motion: `src/components/landing.css`, `src/styles/tokens.css`.
- Regression gate: `e2e/design.spec.ts` plus `test/ui.test.ts`.

## Open decisions

Commercial AIRNT licensing and buyer-specialization research are not resolved. No synthetic test or screenshot proves cloud deployment, scanner production readiness or real-device GPU performance.
