# Landing direction contract

- **Surface and mode:** `/`, Persuade → Understand → Act. A person maintaining a real application should understand that Gotchu reviews a source snapshot and an authorized HTTPS origin, see what the report keeps, and reach `/dashboard` without a fabricated result or forced tour.
- **Visual authority:** the user pinned this world with three references: a brand board (wide techno type, one bold mark, drenched colour panels, repeated wordmark, rounded bento cards), firecrawl.dev (hairline blueprint grid, bracketed mono labels, ASCII and pixel art) and exa.ai (dot fields, mono tags on solid blocks). Colours stay graphite/magenta/porcelain/silver. Nothing realistic: no photos, metal, glass or camera-like objects.
- **Content:** compare source and HTTPS observations with evidence; never claim ongoing monitoring, automated fixes, attack confirmation or complete coverage. No explanatory artwork captions, meta copy or mock-analysis instructions. Labels use real product vocabulary (`SHA-256`, `_gotchu.<dominio>`, severity/confidence/coverage enums, JSON export keys) and never invent values.
- **Signature moment:** the `[◆]` mark rendered in 3D ASCII turns toward the pointer; its brackets snap shut on the finding whenever a `data-catch` action is hovered. The pinned stage spreads the brackets under [ Código ] and [ HTTPS ], closes them behind a giant GOTCHU flash, then hands over to the report panel.
- **Boundaries:** landing, local design context, presentation helpers and tests only. Customer/demo UI, backend, permissions, auth and deployment remain untouched.

## Motion decisions

| Location | Purpose | Frequency | Implementation |
| --- | --- | --- | --- |
| Hero entrance | Arrival | Once | Opacity .35→1, 18px, 4px blur, 700ms strong ease-out, 70ms stagger, `backwards` fill |
| ASCII mark | Delight, product metaphor | While visible | Canvas ray-march per character cell; finding spins slowly; pointer springs `duration .5, bounce .15`; paused off screen and when the tab is hidden; single static frame under reduced motion |
| Catch | Feedback on primary actions | Occasional | Bracket separation springs to 0 (`duration .35, bounce .35`) on `[data-catch]` hover |
| Wordmark rows | Brand texture | Scroll-linked | Alternate rows translate ±11% with section progress and ±3% with pointer; held still under reduced motion |
| Pinned stage | Explanation of the mechanism | Once per visit | 360svh native sticky; smoothed scroll spring `duration .3`; brackets spread (0–.30), close (.42–.50), GOTCHU flash (.47–.66), report enters (.62–.84) |
| Blueprint cell | Spatial delight | Pointer move | Cell under a fine pointer lights magenta; 140ms transform |
| Dot pictograms | State change / delight | Per tab or chapter | Dots morph 620ms `cubic-bezier(.77,0,.175,1)` with 5ms stagger; dots shy 220ms from a fine pointer |
| Chapter sheet | Prevent a jarring swap | Per chapter | `@starting-style` opacity + 18px + 6px blur |
| Press / hover | Feedback | Frequent | .97 press; fine-pointer 2px lift, arrow 4px; nav brackets slide in |
| FAQ | State indication | Occasional | 240ms native disclosure, filled control rotates 45° |

Rejected: loaders, custom cursors, scroll snapping or hijacking, particles that obscure content, photographic or metallic rendering, animated invented metrics.

## Fallbacks

Below 761px wide, below 560px tall, under reduced motion and without JavaScript, the stage renders stacked: the mark with "Dos perspectivas", then "Cada hallazgo" beside the report panel. Without JavaScript the flat SVG mark replaces the ASCII canvas. Small text never sits on `#e7147d`; it uses the action shade `#c80c68`, ink or silver.

## Source and implementation map

- Mark geometry and lockup: `gotchu-mark.tsx`. ASCII render: `ascii-mark.tsx`. Pictograms: `dot-matrix.tsx`. Texture: `wordmark-rows.tsx`. Grid: `blueprint-grid.tsx`. Pointer field: `pointer-field.ts`.
- Hero: `hero.tsx`. Stage: `convergence.tsx`. Journey panels: `product-flow.tsx`. Page and sections: `landing.tsx`, `landing.css`, `src/styles/tokens.css`.
- Display face: Goldman (OFL), self-hosted in `public/fonts` with its license. AIRNT is a visual reference only.
- Regression gate: `e2e/design.spec.ts`, `test/ui.test.ts`.

## Open decisions

Commercial AIRNT licensing and buyer-specialization research remain open. No synthetic test or screenshot proves cloud deployment, scanner production readiness or real-device GPU performance.
