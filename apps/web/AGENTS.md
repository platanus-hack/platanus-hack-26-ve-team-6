# Web design context

Read `PRODUCT.md`, `DESIGN.md` and `design/landing.direction.md` before changing public web presentation. They are scoped to this package. Product truth comes from existing contracts and repository architecture; visual references do not grant product capabilities.

The brand applies to the whole app: the landing at `/` and the customer application (`/dashboard`, `/setup`, `/privacy`, `/terms`). Do not alter auth/permissions, introduce customer-code execution, or deploy to a public host without a new request. Landing-only rules stay scoped to `.g-page`; page roots elsewhere carry the `.gl` class to receive the tokens.

App styles: `src/components/customer-shell.css` (shell, auth page, shared buttons/forms/cards/chips), `customer-report.css`, `customer-operations.css`, `public-legal.css`. The theme switch is `src/components/theme-switch.tsx`; `THEME_SCRIPT` runs from the root route.

## Tools

Project-local Impeccable and Emil Kowalski skills are already installed in the working checkout. They are not vendored binaries. To reproduce their installation from a fresh clone:

```sh
npx --yes impeccable@4.7.0 install -y --providers=hermes,codex --scope=project
npx skills add emilkowalski/skill --yes
```

Read the installed Impeccable skill before using its CLI. Run context for the exact surface from repository root:

```sh
.hermes/skills/impeccable/scripts/impeccable context --target apps/web/src/landing/landing.tsx
```

Before adding motion, load Emil's `find-animation-opportunities`, then `animate` and the relevant recipes. Use `apple-design` for physical continuity and `animation-performance` for the compositor/React cost model. `review-animations` is user-invoked only; ask for it before delivery. Do not animate functional text, add a loader, or hide content pending an entrance.

The landing lives in `src/landing/` (route `/`). Dot fields (`src/components/dot-field/`) follow the pointer on their own canvas loop: never set React state per frame, sleep off screen, in hidden tabs, when paused and under reduced motion. Primary actions carry `data-catch` so the fields gather on their finding while hovered. Keep visuals non-realistic and square-led with a small, smooth radius (buttons 8px, chips 6px, panels 10-14px, cards 16px), hard magenta offset hovers, authored ASCII and living dot fields, gradients only within the brand colours. Keyboard focus uses a contrasting border colour; links use underline or text colour. No focus rings or offset outlines. No photos, metal, glass, camera-like objects or solid 3D renders. Do not bring back the sidebar index, section kickers or section numerals.

## Components and themes

Controls are shadcn/ui (style `base-nova` on Base UI, see `components.json`; the shadcn skill is in `.agents/skills/shadcn`). Add components with `npx shadcn@latest add <name>` from `apps/web`, then restyle them in `src/components/ui/` to DESIGN.md instead of overriding them from page CSS. Navigation styled as a button is a real `<a>` with `buttonVariants`, because Base UI's Button announces anchors as buttons. Theme tokens are the shadcn slots in `src/styles/landing-ui.css`, applied to every page root with the `.gl` class and loaded from the root route; Tailwind loads without preflight so it cannot reset unbranded markup. Page CSS sits in `@layer components` so utility classes win. Light is pure `#ffffff`, dark is pure `#000000`, and system follows the OS; `THEME_SCRIPT` applies the stored choice before paint.

After the finished surface, run the detector and triage real findings rather than suppressing them broadly:

```sh
.hermes/skills/impeccable/scripts/impeccable detect --json apps/web/src/landing/*.{tsx,css} apps/web/src/components/ui/*.tsx apps/web/src/styles/landing-ui.css
```

The shared `.impeccable/config.json` enables supported design hooks. Automatic invocation depends on the current agent host; when context requests a manual detector pass, run it explicitly. Do not claim hooks fired when they did not.

## Verification

```sh
pnpm build:packages
pnpm --filter @gotchu/web typecheck
pnpm --filter @gotchu/web test
pnpm --filter @gotchu/web build
```

There is no automated landing design suite. For visual changes, run the app and check the changed spot in a real browser on desktop and mobile widths, in both themes.

## Editorial and asset rules

Write direct Spanish about implemented features. Never insert artwork explanation, meta/helper copy or mock-analysis instructions. Do not invent scanner output, scores, testimonials, uptime or results: abstract original product assets remove the need for such disclaimers. Genuine scope limits belong in a normal product answer, not captions attached to art.

The landing ships no raster or SVG artwork files: the mark, ASCII plates and dot fields are authored in components (`gotchu-mark.tsx` holds the shared geometry). Do not reuse reference-site assets or unlicensed AIRNT. Respect the OFL files alongside the self-hosted Saira font. Small text never sits on `#e7147d`; use the action shade, ink or silver. Controls are 34px minimum (desktop primary buttons 48px) and the header is 52px (48px on mobile). The 34px minimum replaces the earlier 44px rule at the user's request. Keep installed skill engines, local credentials and test traces out of Git.
