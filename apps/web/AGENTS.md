# Web design context

Read `PRODUCT.md`, `DESIGN.md` and `design/landing.direction.md` before changing public web presentation. They are scoped to this package. Product truth comes from existing contracts and repository architecture; visual references do not grant product capabilities.

Current iteration owns only the landing at `/`. Do not restyle `/dashboard` or `/demo`, alter auth/permissions, introduce customer-code execution, or deploy to a public host without a new request. Scope identity variables and browser-surface rules to `.g-page` so the landing stylesheet cannot recolor the customer application after navigation.

## Tools

Project-local Impeccable and Emil Kowalski skills are already installed in the working checkout. They are not vendored binaries. To reproduce their installation from a fresh clone:

```sh
npx --yes impeccable@4.7.0 install -y --providers=hermes,codex --scope=project
npx skills add emilkowalski/skill --yes
```

Read the installed Impeccable skill before using its CLI. Run context for the exact surface from repository root:

```sh
.hermes/skills/impeccable/scripts/impeccable context --target apps/web/src/components/landing.tsx
```

Before adding motion, load Emil's `find-animation-opportunities`, then `animate` and the relevant recipes. Use `apple-design` for physical continuity and `animation-performance` for the compositor/React cost model. `review-animations` is user-invoked only; ask for it before delivery. Do not animate functional text, add a loader, or hide content pending an entrance.

Objects may follow the pointer across the page: subscribe through `pointer-field.ts` (one shared listener), write transforms on Motion's render frame, never set React state per frame, pause off screen and freeze under reduced motion. Primary actions carry `data-catch` so the ASCII mark's brackets close on the finding while they are hovered. Keep visuals non-realistic and square-led with a small, smooth radius (buttons 8px, chips 6px, panels 10-14px, cards 16px), translucent offset hovers, ASCII, dot-matrix and straight-line grid art, gradients only within the brand colours. No photos, metal, glass, camera-like objects or solid 3D renders. The user overrides Impeccable's eyebrow/section-number bans for the hero scope line and numbered nav taken from their prototype; do not extend them to section kickers. The pinned convergence stage runs only on screens at least 761x560 with motion allowed; every other case keeps the stacked layout with the same content.

After the finished surface, run the detector and triage real findings rather than suppressing them broadly:

```sh
.hermes/skills/impeccable/scripts/impeccable detect --json apps/web/src/components/{landing,hero,convergence,ascii-mark,dot-matrix,blueprint-grid,product-flow}.{tsx,css}
```

The shared `.impeccable/config.json` enables supported design hooks. Automatic invocation depends on the current agent host; when context requests a manual detector pass, run it explicitly. Do not claim hooks fired when they did not.

## Verification

```sh
pnpm build:packages
pnpm --filter @gotchu/web typecheck
pnpm --filter @gotchu/web test
pnpm --filter @gotchu/web exec playwright install chromium
pnpm --filter @gotchu/web test:design
pnpm --filter @gotchu/web build
```

Playwright starts/reuses a loopback-only preview on port 3085. Its tests exercise the actual landing and its native controls, not mocked security assessments. Review rendered desktop and mobile images, pointer following and iris focus, the pinned convergence frames, each scroll chapter, each scope tab, keyboard tabs/FAQ/menu, 320px layout, reduced motion and no-JavaScript content. Full-page screenshots flatten the sticky stage into an empty band; capture viewport by viewport instead. Automated axe checks do not constitute an accessibility certification or a hardware performance benchmark.

## Editorial and asset rules

Write direct Spanish about implemented features. Never insert artwork explanation, meta/helper copy or mock-analysis instructions. Do not invent scanner output, scores, testimonials, uptime or results: abstract original product assets remove the need for such disclaimers. Genuine scope limits belong in a normal product answer, not captions attached to art.

The landing ships no raster or SVG artwork files: the mark, ASCII render, pictograms and grid are authored in components (`gotchu-mark.tsx` holds the shared geometry). Do not reuse reference-site assets or unlicensed AIRNT. Respect the OFL files alongside the self-hosted Archivo and Oxanium fonts. Small text never sits on `#e7147d`; use the action shade, ink or silver. Keep installed skill engines, local credentials and test traces out of Git.
