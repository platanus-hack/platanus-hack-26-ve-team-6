# Landing validation

Scope: public `/` and local design context only. Customer/demo presentation, backend, permissions and authentication are unchanged relative to `origin/main`.

## Sources and editorial review

- Product claims checked against README, `docs/architecture.md`, customer assessment contracts and `customer-dashboard.tsx`.
- Copy distinguishes source snapshots, explicitly authorized HTTPS and combined evidence. No monitoring, automatic fixes, whole-site crawl, execution of uploaded code or guaranteed security is advertised.
- The previous sculpture was removed. Three authored assets are reproducible with `python3 scripts/generate-landing-assets.py`; no Apple/Churupitos artwork, AIRNT or initial loader is included.
- No visible artwork explanations, mock-analysis captions, invented scanner results, metrics or testimonials.

## Verification exercised

- Monorepo `pnpm build`, `pnpm typecheck` and `pnpm test` passed at `6bbafff`: 265 tests passed; 99 infrastructure-dependent cases were skipped by their normal configuration. These skipped cases are not live-infrastructure evidence.
- After integrating the Codex visual refinement: web typecheck, all 48 web tests, the production web build and all 14 Playwright desktop/mobile cases passed again.
- The browser cases include axe checks, pointer tilt/reset, native scrolling through all chapters, ARIA tabs with pointer/keyboard, mobile menu/Escape, FAQ, CTA destinations, a 320px reduced-motion viewport and server-rendered content without JavaScript. Test projections do not replace real-device testing.
- Impeccable detector returned `[]` for the final landing TSX, CSS and lens component.
- Real desktop/mobile screenshots were inspected after integration. The story and scope states were exercised while recording a Chromium walkthrough; the screenshots in `screenshots/` are actual renders.

## Collaborator and final refinements

Codex `gpt-5.6-terra` at high reasoning supplied a read-only patch after Bubblewrap proved unavailable on this host. Parent reviewed/applied the exact file changes and regenerated the assets. The patch adds an optical reflection and glass rim, separates the source/origin planes, softens pointer tilt to ±6°/±4°, and initializes/reapplies the transform when motion preferences change. The collaborator did not edit the worktree or independently execute browser validation. Requested Astra model IDs were rejected by this account; no Astra contribution is claimed.

## Remaining limits

- Build succeeds with upstream bundler warnings about preserved `use client` directives and chunk debug names; these were not suppressed.
- Chromium coverage is local; no Safari/Firefox matrix, hardware GPU benchmark, production deployment or cloud scanner-readiness claim is made.
- Motion intentionally remains bounded and nonessential; reduced-motion and touch do not require following or dragging the object to use the page.
- Commercial AIRNT licensing and buyer-specialization research remain open; neither blocks this landing using the licensed self-hosted Oxanium font.
