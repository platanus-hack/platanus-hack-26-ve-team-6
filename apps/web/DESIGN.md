---
name: Gotchu
description: Evidence-first security review, spoken as a working brand board.
colors:
  graphite: "#191923"
  ink: "#0f0f16"
  surface: "#21212e"
  raised: "#2b2b3a"
  line: "#646174"
  line-soft: "#3d3b4c"
  muted: "#b5b1bb"
  silver: "#c7bfbd"
  silver-track: "#b3aaab"
  on-silver: "#3b3742"
  porcelain: "#fffefa"
  magenta: "#e7147d"
  action: "#c80c68"
  action-hover: "#ac0957"
  accent-ink: "#ff8fbe"
  focus: "#ffabd0"
typography:
  display:
    fontFamily: "Goldman, Oxanium, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "clamp(3rem, 6.6vw, 7.6rem)"
    fontWeight: 700
    lineHeight: 0.9
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Goldman, Oxanium, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "clamp(2.5rem, 4.6vw, 4.5rem)"
    fontWeight: 700
    lineHeight: 0.98
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Goldman, Oxanium, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.005em"
  label:
    fontFamily: "Goldman, Oxanium, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.03em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.65
  lead:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.7
  tag:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.08em"
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.95
rounded:
  dot: "2px"
  chip: "6px"
  code-chip: "8px"
  inset: "14px"
  export: "18px"
  card-mobile: "22px"
  report: "22px"
  sheet: "24px"
  card: "28px"
  pill: "999px"
spacing:
  bento-gap: "12px"
  bento-gap-mobile: "8px"
  card-pad: "clamp(24px, 3vw, 44px)"
  panel-pad: "clamp(32px, 5vw, 72px)"
  container-gutter: "56px"
  section: "140px"
  section-mobile: "80px"
components:
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.porcelain}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "14px 26px"
    height: "54px"
  button-primary-hover:
    backgroundColor: "{colors.action-hover}"
  button-ink:
    backgroundColor: "{colors.graphite}"
    textColor: "{colors.porcelain}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "14px 26px"
    height: "54px"
  button-ink-hover:
    backgroundColor: "{colors.raised}"
  button-small:
    backgroundColor: "{colors.porcelain}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.pill}"
    padding: "10px 18px"
    height: "44px"
  button-small-hover:
    backgroundColor: "{colors.magenta}"
    textColor: "{colors.graphite}"
  card-magenta:
    backgroundColor: "{colors.magenta}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.card}"
    padding: "{spacing.card-pad}"
  card-ink:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.porcelain}"
    rounded: "{rounded.card}"
    padding: "32px"
  card-silver:
    backgroundColor: "{colors.silver}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.card}"
    padding: "{spacing.card-pad}"
  card-action:
    backgroundColor: "{colors.action}"
    textColor: "{colors.porcelain}"
    rounded: "{rounded.card}"
    padding: "32px"
  tag-pill:
    backgroundColor: "{colors.graphite}"
    textColor: "{colors.porcelain}"
    typography: "{typography.tag}"
    rounded: "{rounded.pill}"
    padding: "8px 12px"
  tab-track:
    backgroundColor: "{colors.silver-track}"
    rounded: "{rounded.pill}"
    padding: "6px"
  tab-selected:
    backgroundColor: "{colors.graphite}"
    textColor: "{colors.porcelain}"
    rounded: "{rounded.pill}"
    height: "52px"
  report-card:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.silver}"
    rounded: "{rounded.report}"
    padding: "16px 22px"
---

# Design System: Gotchu

## Overview

**Creative North Star: "The Working Brand Board"**

Gotchu speaks like an identity system that also does the job: one bold mark, giant wide uppercase type, drenched colour fields, and technical blueprint detail. Every surface is a rounded bento card on a graphite ground; the cards carry flat colour, type and authored digital art (ASCII render, dot-matrix pictograms, repeated wordmark rows, hairline grid), never representations of physical things. Content is the real product vocabulary (SHA-256, `_gotchu.<dominio>`, report enums, JSON export keys) and is never padded with invented results.

The mark `[◆]` is two scope brackets closing on a magenta finding. It is the only symbol of the world and it carries the signature behaviour: the brackets spread and snap shut. Density is low and loud: few elements, each at full size.

The landing tokens are scoped to `.g-page`; customer and demo surfaces keep their own styles until they are deliberately moved into this world.

**Key Characteristics:**
- Graphite ground, magenta display fields, silver and ink cards, porcelain type.
- Goldman 700 uppercase for everything that speaks; platform sans for reading; ui-monospace bracket tags for labels.
- Rounded bento cards (28px) and pill controls; no square controls.
- Authored digital art only: ASCII 3D mark, 11×11 dot pictograms, wordmark rows, 96px blueprint grid.
- Motion is bracket-and-field motion; every moving piece has a still, stacked equivalent.

## Colors

Four brand colours (graphite, magenta, porcelain, silver) on a tonal graphite ladder, with a darker magenta that carries small text.

### Primary
- **Signal Magenta** (magenta): the display field. Fills hero and closing cards, the GOTCHU flash, the finding in the mark, dot pictograms, the blueprint hover cell (8% fill, 40% hairline) and the open FAQ control.
- **Action Magenta** (action): every surface where small text meets the magenta family: primary buttons, the history card, JSON and code chips, text selection, the ASCII finding's shadow side. Hover deepens to action-hover.
- **Pink Ink** (accent-ink): magenta as text on dark: nav brackets, stage-headline accents, step numerals, export link, selected-tab icon, the lit face of the ASCII finding.

### Neutral
- **Graphite** (graphite): page ground, ink buttons, primary type on magenta and silver, the hero tag pill, wordmark rows (at `#1919231c` on magenta).
- **Ink** (ink): darkest card: ASCII stage, scope stage, workflow cards, report and flow sheets. Ink cards carry a 1px inset porcelain hairline at 8%.
- **Surface / Raised** (surface, raised): mobile menu, sheet footers, FAQ control at rest, ink-button hover.
- **Line / Line-soft** (line, line-soft): hairlines, dividers, outlined chips; line-soft also fills the ASCII dust.
- **Porcelain** (porcelain): headings on dark and the porcelain half of a two-tone headline; the small nav button.
- **Silver** (silver): body copy on dark, and the third card colour. On silver, body copy is on-silver and the tab track is silver-track.
- **Muted** (muted): tags inside ink cards, idle chapter headings, footer tag.
- **Focus** (focus): 2px outline, 4px offset, on every focusable element.

### Named Rules
**The Small-Text Rule.** Small text never sits on signal magenta (porcelain reaches only about 4.4:1, graphite about 4:1). Magenta takes display type, graphic marks and fields; a card that needs body copy switches to action magenta, or puts the text on a graphite pill.

**The Two-Tone Headline Rule.** On magenta and silver fields a headline is graphite with its last clause in porcelain; on dark, porcelain with the accent clause in pink ink.

## Typography

**Display Font:** Goldman 700 (self-hosted OFL, `public/fonts`), falling back to Oxanium then the platform sans
**Body Font:** platform sans (`-apple-system, BlinkMacSystemFont, 'Segoe UI'`)
**Label/Mono Font:** ui-monospace

**Character:** a wide techno face shouting in uppercase over a quiet system sans; mono tags read like the labels on a technical drawing.

### Hierarchy
- **Display** (700, clamp(3rem, 6.6vw, 7.6rem), 0.9, uppercase): hero headline only; mobile clamp(2.6rem, 13.5vw, 4.4rem). Bigger relatives: the GOTCHU flash clamp(6rem, 19vw, 20rem) and the footer wordmark clamp(3.6rem, 15.5vw, 16rem) at -0.035em.
- **Headline** (700, clamp(2.5rem, 4.6vw, 4.5rem), 0.98, uppercase, max 14ch): section headings; 36px on mobile. Closing headline runs larger, clamp(2.6rem, 6vw, 6.4rem)/0.92.
- **Title** (700, 22–26px, 1.1, uppercase): card and sheet titles; chapter headings clamp(2.1rem, 3.6vw, 3.4rem)/1.
- **Label** (700, 14px, 0.03em, uppercase): button text, secondary links (13px), tabs (15px), report terms.
- **Body** (400, 16px, 1.65): reading copy in silver; leads 17–18px/1.7 at 420–580px measure.
- **Tag** (600, 12px, 0.08em, uppercase mono): `[ bracketed ]` labels and nav links.
- **Code** (14px/1.95 mono): export listing with gutter line numbers; DNS record at 18px.

### Named Rules
**The Uppercase Voice Rule.** Goldman is always 700 and always uppercase, with negative tracking at headline sizes and positive tracking at label sizes. Body copy is never set in Goldman.

**The Licence Rule.** AIRNT is a visual reference only. Ship Goldman (OFL, licence file alongside the woff2); never embed or distribute AIRNT without licence evidence.

## Layout

A bento page: cards sit 12px apart (8px on mobile), inset 12px from the viewport edge (8px on mobile), with text sections in a container of min(1180px, 100% − 112px) narrowing to 100% − 64px under 1050px and 100% − 40px under 760px. The first viewport is a three-card bento: a 1.62fr magenta type card spanning two rows beside an ink mark card over a silver pitch card, filling max(640px, 100svh − 12px). Sections breathe at 120–140px vertical (72–80px mobile). Breakpoints are 1050px (bento to two columns, two-column grids to one) and 760px (single column, mobile menu, 22px card radii).

The blueprint grid is a 96px hairline lattice (porcelain at 6%) with plus marks at the crossings (porcelain at 32%), masked to fade at the top and bottom 10%; under a fine pointer the cell beneath lights magenta.

## Elevation & Depth

Flat. Depth comes from tonal cards (ink below graphite below raised) and hairlines, not shadows. The fixed header is a translucent graphite scrim (80% with an 18px blur), which turns solid under reduced transparency or increased contrast.

### Shadow Vocabulary
- **Ink hairline** (`box-shadow: inset 0 0 0 1px #fffefa14`): edge of ink cards on graphite.
- **Floating report** (`box-shadow: 0 30px 70px #08070d99`): only the report card, which floats over the pinned stage.

### Named Rules
**The Flat Card Rule.** Cards are colour fields, not objects. No bevels, gloss, metal, glass panels or realistic lighting; the single drop shadow belongs to the floating report card.

## Shapes

Generous, consistent rounding nested by scale: cards 28px (22px mobile), flow sheet 24px, report card and mobile menu 22px, export frame 18px, inset record 14px, code chips 8px, JSON chips 6px, dots 2px. Controls and tags are full pills. The finding is a diamond (a square rotated 45°); list bullets repeat it in graphite at 10px. Brackets are the recurring silhouette: in the mark, around tags, and sliding in beside nav links on hover.

## Components

### Buttons
- **Shape:** full pill (999px), 54px tall; 44px for the small nav button.
- **Primary:** action magenta with porcelain Goldman label, 14px 26px, trailing arrow with a 26px gap.
- **Ink:** graphite with porcelain label; used on magenta and silver cards. Hover raises to raised.
- **Small:** porcelain with graphite label in the header; hover turns signal magenta.
- **Hover / Press:** fine pointers lift 2px and push the arrow 4px over 160ms `cubic-bezier(0.23, 1, 0.32, 1)`; press scales to 0.97. Reduced motion keeps colour changes only.
- **Catch:** every primary path into `/dashboard` carries `data-catch`; hovering it snaps the ASCII mark's brackets shut (spring 0.35s, bounce 0.35).
- **Secondary link:** Goldman 13px uppercase text with a trailing arrow, no fill.

### Chips and Tags
- **Bracket tag:** mono 12px uppercase in `[ brackets ]`, naming a real thing (a perspective, a file, the export). Pinned to the corner of the card or figure it names, muted on ink.
- **Pill tag:** a bracket tag on a graphite pill, for a state statement on a magenta field.
- **Code chips:** mono 12px with a 1px line border (8px), or action-magenta fill (6px) for the JSON marker.

### Cards / Containers
- **Corner Style:** 28px; 22px under 760px.
- **Background:** magenta (display), ink (art and evidence), silver (pitch and scope), action (body copy on the magenta family).
- **Shadow Strategy:** flat; ink cards take the inset hairline.
- **Internal Padding:** clamp(24px, 3vw, 44px) for type cards, 32px for workflow cards, clamp(32px, 5vw, 72px) for full-width panels.

### Navigation
Fixed 72px header (64px mobile): Goldman 22px uppercase brand with the mark; mono 12px silver links whose pink-ink brackets slide in on hover; the small pill button at the end. Under 760px, a pill "Menú" toggle opens a 22px-radius surface panel and Escape closes it.

### Tabs
A silver-track pill (6px inset) with a graphite indicator that slides 300ms `cubic-bezier(.77, 0, .175, 1)`; selected label porcelain with a pink-ink icon. Arrow keys, Home and End move selection.

### Disclosure (FAQ)
Native `details` rows between line hairlines, 84px summaries in 18px semibold body; a 36px round raised control turns signal magenta and rotates 45° when open; height animates 240ms.

### Signature: the `[◆]` mark
- **ASCII render:** a canvas ray-marches the mark per character cell using the ramp `.:-=+*#%@`: brackets in `#8f8896`/porcelain, finding in action/pink ink, dust in line-soft. It turns toward the pointer (spring 0.5s, bounce 0.15), spins slowly, pauses off screen and in hidden tabs, and paints one still frame under reduced motion. Without JavaScript the flat SVG mark shows instead.
- **Pinned stage:** 360svh of native sticky scroll; the brackets spread under [ Código ] and [ HTTPS ], close, and a full magenta GOTCHU field wipes in from below and out through the top (clip-path, never a translucent tint), handing over to the report card.
- **Stacked fallback:** below 761px wide, below 560px tall, under reduced motion and without JavaScript, the stage renders stacked: the mark with its copy, then the second step beside the report card.

### Dot-matrix pictograms
11×11 grids of 74% rounded-square dots in currentColor (magenta by default, porcelain on action cards). Each card gets one dominant pictogram; dots morph 620ms with a 5ms stagger and shy 220ms from a fine pointer.

### Wordmark rows
Repeated GOTCHU-and-mark rows behind magenta type, alternating solid and outlined, at graphite 11% alpha. Rows drift ±11% with scroll and ±3% with the pointer, and hold still under reduced motion.

## Do's and Don'ts

### Do:
- **Do** put small text on action magenta, graphite, ink or silver, never on signal magenta.
- **Do** set every display line in Goldman 700 uppercase and every reading line in the platform sans.
- **Do** build sections as 28px bento cards on graphite, 12px apart, with pill controls.
- **Do** label with real product vocabulary in mono bracket tags attached to the thing they name.
- **Do** mark every primary path into the product with `data-catch` so the mark catches it.
- **Do** give every moving piece a still, stacked equivalent for reduced motion, small or short viewports and no-JS.
- **Do** make art from the world's own materials: the mark, ASCII, dots, wordmark rows, the blueprint grid.

### Don't:
- **Don't** show a loader or splash before content.
- **Don't** add captions or helper copy that explain the artwork or the page.
- **Don't** invent results, metrics, findings, customers or animated pseudo-data; show product structure instead.
- **Don't** use anything realistic: photos, metal, glass objects, camera-like renders, 3D product objects.
- **Don't** set small text on signal magenta (#e7147d).
- **Don't** ship or embed AIRNT; Goldman is the licensed face.
- **Don't** use custom cursors, scroll snapping or hijacking, or particles that cover content.
- **Don't** use a bracket tag as a kicker above a section headline.
