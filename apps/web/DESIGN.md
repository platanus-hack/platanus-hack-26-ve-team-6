---
name: Gotchu
description: Evidence-first security assessment, expressed through an original optical instrument.
colors:
  canvas: "#191923"
  surface: "#21212e"
  raised: "#2b2b3a"
  paper: "#fffefa"
  silver: "#c7bfbd"
  muted: "#b5b1bb"
  line: "#646174"
  line-soft: "#3d3b4c"
  magenta: "#e7147d"
  action: "#c80c68"
  action-hover: "#ac0957"
  accent-ink: "#ff8fbe"
  focus: "#ffabd0"
  contact-shadow: "#08070d"
  on-paper-muted: "#55505a"
  on-paper-neutral: "#69616c"
  on-paper-selected: "#eee8ec"
  on-paper-accent: "#9d0c54"
typography:
  display:
    fontFamily: "Oxanium, sans-serif"
    fontSize: "clamp(2.75rem, 5.5vw, 5rem)"
    fontWeight: 500
    lineHeight: 1.1
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Oxanium, sans-serif"
    fontSize: "clamp(2.25rem, 3.8vw, 3.5rem)"
    fontWeight: 500
    lineHeight: 1.12
    letterSpacing: "-0.035em"
  mobile-display:
    fontFamily: "Oxanium, sans-serif"
    fontSize: "clamp(1.75rem, 7.8vw, 3.5rem)"
  closing:
    fontFamily: "Oxanium, sans-serif"
    fontSize: "clamp(2.25rem, 4.2vw, 4rem)"
  mobile-closing:
    fontFamily: "Oxanium, sans-serif"
    fontSize: "clamp(1.75rem, 6.4vw, 2.75rem)"
  small-label:
    fontSize: "12px"
  supporting:
    fontSize: "14px"
  lead:
    fontSize: "18px"
  scope:
    fontSize: "24px"
  subheading:
    fontSize: "32px"
  mobile-headline:
    fontSize: "36px"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.4
rounded:
  control: "6px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  section: "48px"
components:
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
    padding: "14px 24px"
  button-primary-hover:
    backgroundColor: "{colors.action-hover}"
  button-header:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.canvas}"
    height: "44px"
  button-scope-selected:
    backgroundColor: "#eee8ec"
    textColor: "#9d0c54"
---

## Overview

This iteration owns the public landing at `/`, not a dashboard redesign. The direction is an original evidence lens: a machined optical instrument brings source and authorized HTTPS into a shared frame. The supplied prototype informs color and professional tone, **not composition or reusable artwork**. Apple informs physical continuity and product-scale storytelling; Churupitos informs responsive object play, not its loader or mascot.

Authority: `PRODUCT.md` defines product truth; this document defines visual identity; `design/landing.direction.md` defines the current surface. `src/styles/tokens.css` is the executable token source. Keep these synchronized. No commercial AIRNT asset is included; the locally hosted Oxanium font includes its OFL license.

## Colors

Graphite is the reading environment; warm white provides one deliberate change of pace for choosing scope. Silver supports secondary copy. Magenta identifies the optical rim and a few decision points, never a full-screen moving background.

Use the action shade for normal-size button text, not raw brand magenta, which does not meet normal-text contrast with white. Use accent-ink for small colored text on graphite. On white, the selected scope uses `#9d0c54`. Keep body text at least 4.5:1 and large text at least 3:1. Do not invent status colors or scoreboards for marketing decoration.

## Typography

Oxanium is a product voice, not an instruction to typeset every paragraph as science fiction. Use medium-weight, balanced headings, tracking no tighter than -0.04em and maximum content display size 5rem. The footer wordmark is a separate brand treatment, 6–16rem, not a content heading. Body is platform sans with 1.65–1.75 leading. Desktop hero is centered; mobile keeps two coherent lines with a smaller responsive display size. Preserve Spanish accents in actual text. Do not simulate missing glyphs.

## Layout

The sequence is centered headline and original product object; a scroll-linked narrative with a sticky object and three real product distinctions; a light scope selector; native FAQ; a short closing action and typographic footer. Do not reuse the earlier split hero, boxed radial sculpture, ticker band or numbered-card grid.

Container max is 1180px; side gutters are 56px above 1050px, 32px up to 1050px, and 20px up to 760px. The header uses its own wider 1300px shell. Desktop story holds the object beside the copy; mobile shows the hero object once and presents the three chapters as direct content, without sticky obstruction. Never hijack scrolling or require an animation to finish before continuing.

## Elevation & Depth

Depth belongs to the optical object, not arbitrary cards. Three original SVG assets use static metal, glass and bevel shading; CSS perspective creates spatial relationships. The bounded contact shadow grounds the object. The sticky header uses restrained translucency to separate content beneath it; reduced transparency and high contrast use a solid surface. Do not animate large blur or shadows.

## Shapes

Machined circles are specific to the lens; panels represent a source snapshot and an HTTPS origin. They are not a chart, a live scanner or a completed assessment. Controls use 6px corners and consistent authored SVG strokes. Every asset is generated by `scripts/generate-landing-assets.py`. Do not reuse the old sculpture or assets from inspiration websites.

## Components

- **Actions:** anchors navigate to the existing `/dashboard`; no waitlist or fake form. Press feedback is 160ms and scale .97. Fine-pointer hover shifts 2px; touch has no hover movement.
- **Lens:** `EvidenceLens` uses Motion springs, duration .4 and bounce 0, on direct element transforms. Pointer response is fine-pointer-only. Scroll provides bounded 18px depth travel; the sticky story changes the spatial relationship at chapter boundaries. No React state updates per animation frame, no autonomous loops and no loader.
- **Scope selector:** three ARIA tabs; ArrowLeft/Right and Home/End move focus and selection. All controlled panels exist. Pointer selection gets a 200ms opacity crossfade; keyboard selection remains immediate.
- **FAQ:** native details/summary, Enter/Space support, 200ms disclosure with a non-animated fallback. Responses explain actual scope rather than making guarantees.
- **Menu:** native button, explicit expanded state, Escape returns focus. No modal and no focus trap because the page remains available.
- **Fallbacks:** reduced motion freezes pointer/scroll travel, keeps content and subtle state colors. Server-rendered heading and main CTA work without JavaScript. All meaningful content is outside decorative images.

## Do's and Don'ts

- Start from implemented capabilities: source snapshots, authorized HTTPS, persisted reports, comparisons and evidence provenance.
- Create original assets for those concepts. Use no fabricated scores, customer lists, live statuses, result counts or certifications.
- Never add explanatory artwork captions, meta-comments about the page, demo instructions or mock-analysis disclaimers. Avoid invented data so those captions are unnecessary. Real scope boundaries belong naturally in the product description or FAQ.
- Never add an initial loader, cursor replacement, sound, scroll locking, infinite motion, background particles or motion on text being read.
- Keep keyboard focus visible, touch targets at least 44px, and every link/control operational. Test 320px and 390px widths as well as desktop.
- Do not apply this landing theme to `/dashboard` or `/demo` in this iteration. Token scope is `.g-page`, not `:root`.
