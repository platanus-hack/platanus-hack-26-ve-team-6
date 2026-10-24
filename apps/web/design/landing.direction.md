# Landing direction contract

- **Surface and mode:** `/`, Persuade → Understand → Act. A person maintaining a real application should understand that Gotchu puts a source snapshot and an authorized HTTPS origin under one lens, see what the report keeps, and reach `/dashboard` without a fabricated result or forced tour.
- **Visual authority:** graphite/magenta/porcelain with Oxanium, unchanged. The world is a machined lens-eye: brushed conic metal, dark glass, aperture blades, CSS-3D objects with real thickness. Apple (MacBook Pro) informs the pinned product story and physical springs; Churupitos informs objects that respond to the visitor. No borrowed artwork, code or initial loader.
- **Content:** compare source and HTTPS observations with evidence; never claim ongoing monitoring, automated fixes, attack confirmation or complete coverage. No explanatory artwork captions, meta copy or mock-analysis instructions anywhere. Object labels name real product concepts (`SHA-256`, `TXT _gotchu.<dominio>`, report keys) and never invent values.
- **Signature moment:** the headline "Tu código. ◉ Tu web." sets the lens inside the sentence. Its iris follows the pointer across the whole page, blinks once after hydration and narrows on primary actions (`data-lens-focus`). Scrolling the pinned stage parts the words, draws the code slab and HTTPS globe into the opening, then moves the lens aside and returns the report along a beam.
- **Boundaries:** landing, local design context, presentation helpers and tests only. Customer/demo UI, backend, permissions, auth and deployment remain untouched.

## Motion decisions

| Location | Purpose | Frequency | Implementation |
| --- | --- | --- | --- |
| Hero entrance | Arrival | Once | Opacity .35→1, 14px, 4px blur, 700ms strong ease-out, 70ms stagger, `backwards` fill so scroll transforms take over |
| Lens blink | Delight, signals the object is alive | Once per load | Aperture .72→.04→.72 in 750ms, 500ms after hydration |
| Pointer following | Spatial delight on a marketing page | Continuous while pointer moves | One shared window listener; per-object springs `duration .5, bounce .15`; ±13–22° tilt; iris translate; metal sheen turns with tilt; paused off screen |
| Iris focus | Feedback on primary actions | Occasional | Spring to .22 opening (`duration .45, bounce .2`), back with bounce 0 |
| Convergence | Explanation of the product mechanism | Once per visit | 340svh native sticky stage; smoothed scroll spring `duration .3`; transforms/opacity written directly per frame; cubic ease-in-out segments |
| Chapter sheet | Prevent a jarring panel swap | Per chapter | `@starting-style` opacity + 28px + rotateY(-10°) + 6px blur, 320–420ms |
| Scope regroup | Spatial consistency between tabs | Occasional | Transform/opacity 640ms `cubic-bezier(.77,0,.175,1)`; indicator 300ms |
| Press / hover | Feedback | Frequent | .97 press; fine-pointer lift 2px, glint sweep 700ms, arrow 4px |
| FAQ | State indication | Occasional | 240ms native disclosure, ringed control rotates 45° |

Rejected: perpetual rotation or idle loops, page loader, custom cursor, scroll snapping or hijacking, magnetic buttons, animated invented metrics, particles. The pinned sequence never blocks scrolling, and focus on a faded hero action scrolls back to the start.

## Fallbacks

Below 761px wide, below 560px tall, under reduced motion and without JavaScript, the stage renders stacked: hero, "Dos perspectivas", then "Cada hallazgo" beside the report. Reduced motion also freezes pointer tilt and iris tracking. Touch input moves the iris to the tapped point.

## Source and implementation map

- Asset generator: `scripts/generate-landing-assets.py` → `public/landing/code-slab.svg`, `report-sheet.svg`.
- Procedural geometry: aperture blades (`lens-eye.tsx`), projected globe and orbit (`spatial-objects.tsx`).
- Pointer field and facing springs: `src/components/pointer-field.ts`.
- Stage choreography: `src/components/convergence.tsx` / `.css`.
- Objects: `lens-eye.tsx`, `spatial-objects.tsx` (CodeSlab, OriginGlobe, ReportSheet, `useTilt`).
- Product panels: `product-flow.tsx` / `.css`; source of truth is `customer-dashboard.tsx` and `packages/contracts`.
- Page and theme: `landing.tsx`, `landing.css`, `src/styles/tokens.css`.
- Regression gate: `e2e/design.spec.ts`, `test/ui.test.ts`.

## Open decisions

Commercial AIRNT licensing and buyer-specialization research remain open. No synthetic test or screenshot proves cloud deployment, scanner production readiness or real-device GPU performance.
