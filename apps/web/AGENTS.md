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

Before adding motion, load Emil's `find-animation-opportunities`, then `animate` and the relevant recipes. Use `apple-design` for physical continuity and `animation-performance` for the compositor/React cost model. Review with `review-animations` before delivery. Do not animate functional text, add a loader, or hide content pending an entrance.

After the finished surface, run the detector and triage real findings rather than suppressing them broadly:

```sh
.hermes/skills/impeccable/scripts/impeccable detect --json apps/web/src/components/landing.tsx apps/web/src/components/landing.css apps/web/src/components/evidence-lens.tsx
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

Playwright starts/reuses a loopback-only preview on port 3085. Its tests exercise the actual landing and its native controls, not mocked security assessments. Review rendered desktop and mobile images, pointer motion, each scroll chapter, keyboard tabs/FAQ/menu, 320px layout, reduced motion and no-JavaScript content. Automated axe checks do not constitute an accessibility certification or a hardware performance benchmark.

## Editorial and asset rules

Write direct Spanish about implemented features. Never insert artwork explanation, meta/helper copy or mock-analysis instructions. Do not invent scanner output, scores, testimonials, uptime or results: abstract original product assets remove the need for such disclaimers. Genuine scope limits belong in a normal product answer, not captions attached to art.

Assets are authored and reproducible via `python3 scripts/generate-landing-assets.py`. Do not reuse the old reference sculpture, Apple product images, Churupitos assets, or unlicensed AIRNT. Respect the OFL file alongside the self-hosted Oxanium font. Keep installed skill engines, local credentials and test traces out of Git.
