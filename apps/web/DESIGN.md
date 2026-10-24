---
name: Gotchu
description: Evidence-first security review, spoken as a square brutalist brand board.
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
    fontSize: "clamp(2.4rem, 4.3vw, 4.6rem)"
    fontWeight: 700
    lineHeight: 1.08
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
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.6
    letterSpacing: "0.1em"
  nav:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.08em"
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.95
rounded:
  none: "0px"
  button: "2px"
spacing:
  inset: "12px"
  inset-mobile: "8px"
  wrap-gutter: "clamp(20px, 4.2vw, 68px)"
  card-pad: "32px"
  panel-pad: "clamp(32px, 5vw, 72px)"
  container-gutter: "56px"
  section: "140px"
  section-mobile: "80px"
components:
  button-paper:
    backgroundColor: "{colors.porcelain}"
    textColor: "{colors.graphite}"
    typography: "{typography.label}"
    rounded: "{rounded.button}"
    padding: "14px 26px"
    height: "54px"
  button-paper-hover:
    backgroundColor: "{colors.silver}"
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.porcelain}"
    typography: "{typography.label}"
    rounded: "{rounded.button}"
    padding: "14px 26px"
    height: "54px"
  button-primary-hover:
    backgroundColor: "{colors.action-hover}"
  button-ink:
    backgroundColor: "{colors.graphite}"
    textColor: "{colors.porcelain}"
    typography: "{typography.label}"
    rounded: "{rounded.button}"
    padding: "14px 26px"
    height: "54px"
  button-ink-hover:
    backgroundColor: "{colors.raised}"
  button-small:
    backgroundColor: "{colors.porcelain}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.button}"
    padding: "10px 18px"
    height: "44px"
  button-small-hover:
    backgroundColor: "{colors.silver}"
  card-magenta:
    backgroundColor: "{colors.magenta}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.none}"
    padding: "{spacing.panel-pad}"
  card-ink:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.porcelain}"
    rounded: "{rounded.none}"
    padding: "{spacing.card-pad}"
  card-silver:
    backgroundColor: "{colors.silver}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.none}"
    padding: "{spacing.panel-pad}"
  card-action:
    backgroundColor: "{colors.action}"
    textColor: "{colors.porcelain}"
    rounded: "{rounded.none}"
    padding: "{spacing.card-pad}"
  hero-frame:
    backgroundColor: "{colors.graphite}"
    rounded: "{rounded.none}"
    height: "clamp(480px, 40vw, 580px)"
  signal-band:
    backgroundColor: "{colors.magenta}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.none}"
    height: "84px"
  tab-track:
    backgroundColor: "{colors.silver-track}"
    rounded: "{rounded.none}"
    padding: "6px"
  tab-selected:
    backgroundColor: "{colors.graphite}"
    textColor: "{colors.porcelain}"
    rounded: "{rounded.none}"
    height: "52px"
  report-card:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.silver}"
    rounded: "{rounded.none}"
    padding: "16px 22px"
---

# Design System: Gotchu

## Overview

**Creative North Star: "The Square Brand Board"**

Gotchu speaks like an identity system that also does the job, cut square: one bold mark, wide uppercase type, drenched colour fields and technical blueprint detail, all on straight lines. Panels, cards, tabs, chips and pixels have no radius; framed panels carry corner ticks; hover answers with a hard offset shadow. Art is digital and authored from the world's own materials (the ASCII mark, square dot-matrix pictograms, hairline blueprint grids, square radar motion), never solid 3D objects or realistic renders. Content is real product vocabulary (SHA-256, `_gotchu.<dominio>`, report enums, JSON export keys) and is never padded with invented results.

The mark `[◆]` is two scope brackets closing on a magenta finding. It is the only symbol of the world and carries the signature behaviour: the brackets spread and snap shut. The interface stays clean: few elements, each at full size, with no captions explaining the artwork.

The landing tokens are scoped to `.g-page`; customer and demo surfaces keep their own styles until they are deliberately moved into this world.

**Key Characteristics:**
- Graphite ground, magenta display fields, silver and ink panels, porcelain type.
- Goldman 700 uppercase for everything that speaks; platform sans for reading; ui-monospace for tags, nav and numbers.
- Square geometry: 0 radius everywhere, 2px on buttons; corner ticks on framed panels; hard 4px offset shadows on hover.
- ASCII and pixel art only: the ASCII mark, 11×11 square-dot pictograms, blueprint grids.
- Motion moves in straight lines and squares (scan lines, widening square radar, sliding bars); every moving piece has a still equivalent.

## Colors

Four brand colours (graphite, magenta, porcelain, silver) on a tonal graphite ladder, with a darker magenta that carries small text.

### Primary
- **Signal Magenta** (magenta): the display field. Fills the flow band and closing card, the GOTCHU flash, the finding in the mark, dot pictograms, the accent clause of the hero headline, scope squares, the blueprint scan line and hover cell, the open FAQ control, and the hard hover shadow on light and ink buttons.
- **Action Magenta** (action): every surface where small text meets the magenta family: the primary button, the history card, JSON and code chips, text selection, the ASCII finding's shadow side, and the far end of every magenta gradient. Hover deepens to action-hover.
- **Pink Ink** (accent-ink): magenta as text on dark: nav numbers, stage-headline accents, DNS step numerals, export link, selected-tab icon, the lit face of the ASCII finding.

### Neutral
- **Graphite** (graphite): page ground and the solid header, ink buttons, type on magenta and silver, the dark end of the closing gradient.
- **Ink** (ink): darkest panel: scope stage, workflow cards, report card, flow sheets, the low end of the hero frame. Ink cards carry a 1px inset porcelain hairline at 8%.
- **Surface / Raised** (surface, raised): mobile menu, sheet footers, the top of the hero frame gradient, FAQ control at rest, ink-button hover.
- **Line / Line-soft** (line, line-soft): hairlines, dividers, outlined chips; line-soft also fills the ASCII dust and unlit chapter bars.
- **Porcelain** (porcelain): headings on dark, the paper and small buttons, the hard hover shadow on the primary button, the radar squares.
- **Silver** (silver): body copy on dark, corner ticks, frame hairlines (at 21% alpha), and the silver panel. On silver, body copy is on-silver and the tab track is silver-track.
- **Muted** (muted): tags inside frames and ink cards, idle chapter headings, the hero note and scope row.
- **Focus** (focus): 2px outline, 4px offset, on every focusable element.

### Named Rules
**The Small-Text Rule.** Small text never sits on signal magenta (porcelain reaches only about 4.4:1, graphite about 4:1) and graphite never sits on action magenta (about 3.1:1). Magenta takes display type, graphic marks and fields; a card that needs body copy switches to action magenta with porcelain text, or puts the text on graphite.

**The Brand Gradient Rule.** Gradients run only between brand colours: magenta to action (flow band, 100°), magenta to action to graphite (closing card, 125°), surface to graphite to ink with a magenta glow (hero frame), magenta fading to transparent (scan line). No other hue ever enters a gradient.

**The Two-Tone Headline Rule.** On magenta and silver fields a headline is graphite with its last clause in porcelain; on dark, porcelain with the accent clause in signal magenta at hero size or pink ink at section size.

## Typography

**Display Font:** Goldman 700 (self-hosted OFL, `public/fonts`), falling back to Oxanium then the platform sans
**Body Font:** platform sans (`-apple-system, BlinkMacSystemFont, 'Segoe UI'`)
**Label/Mono Font:** ui-monospace

**Character:** a wide techno face shouting in uppercase over a quiet system sans; mono tags and numbers read like the labels on a technical drawing.

### Hierarchy
- **Display** (700, clamp(2.4rem, 4.3vw, 4.6rem), 1.08, uppercase): hero headline only, two lines; mobile clamp(2rem, 9.6vw, 3rem). Bigger relatives: the GOTCHU flash clamp(6rem, 19vw, 20rem), the closing headline clamp(2.6rem, 6vw, 6.4rem)/0.92 and the footer wordmark clamp(3.6rem, 15.5vw, 16rem) at -0.035em.
- **Headline** (700, clamp(2.5rem, 4.6vw, 4.5rem), 0.98, uppercase, max 14ch): section headings; 36px on mobile. Stage headings clamp(2.25rem, 4.4vw, 4.25rem)/1.
- **Title** (700, 22–26px, 1.1, uppercase): card and sheet titles; chapter headings clamp(2.1rem, 3.6vw, 3.4rem)/1.
- **Label** (700, 14px, 0.03em, uppercase): button text, secondary links (13px), tabs (15px), report terms; flow-band verbs run clamp(1.1rem, 2.3vw, 2rem).
- **Body** (400, 16px, 1.65): reading copy in silver; the hero lead 16px/1.8 at 480px; section leads 17–18px/1.7 at 420–580px measure.
- **Tag** (600, 11px, 0.1em, uppercase mono): `[ bracketed ]` labels, frame labels, the hero scope line and scope row.
- **Nav** (600, 12px, 0.08em, uppercase mono): header links, with 10px pink-ink numbers.
- **Code** (14px/1.95 mono): export listing with gutter line numbers; DNS record at 18px.

### Named Rules
**The Uppercase Voice Rule.** Goldman is always 700 and always uppercase, with negative tracking at headline sizes and positive tracking at label sizes. Body copy is never set in Goldman.

**The Licence Rule.** AIRNT is a visual reference only. Ship Goldman (OFL, licence file alongside the woff2); never embed or distribute AIRNT without licence evidence.

## Layout

The first viewport follows the user's prototype: a two-column hero inside a 1480px wrap with clamp(20px, 4.2vw, 68px) gutters, copy at 1.12fr beside a framed blueprint panel at 1fr (gap 24px 40px, 128px top padding under the 80px header), a full-width scope row closed by a hairline, then a full-bleed four-column magenta flow band. Below 1050px the hero stacks and the band becomes 2×2; below 760px the frame drops to 380px and the header to 64px.

Lower sections use a container of min(1180px, 100% − 112px), narrowing to 100% − 64px under 1050px and 100% − 40px under 760px. Full-width panels (perspectives, closing) sit 12px in from the viewport (8px on mobile); workflow cards sit 12px apart. Sections breathe at 120–140px vertical (72–80px mobile).

The blueprint grid is a 96px hairline lattice (porcelain at 6%) with plus marks at the crossings (porcelain at 32%), masked to fade at the top and bottom 10%; under a fine pointer the cell beneath lights magenta. The hero frame carries its own 30px grid, a centred square with a dashed outer square, crosshair axes and magenta corner marks.

## Elevation & Depth

Flat surfaces with brutalist hover. Depth at rest comes from tonal panels (ink below graphite below raised) and hairlines. The header is a solid graphite bar with a silver hairline at 21%; nothing is translucent or blurred. On a fine pointer, buttons answer hover by shifting up-left 2px over a hard, unblurred 4px offset shadow.

### Shadow Vocabulary
- **Hard offset, porcelain** (`box-shadow: 4px 4px 0 #fffefa` with `translate(-2px, -2px)`): hover on the action-magenta primary button.
- **Hard offset, magenta** (`box-shadow: 4px 4px 0 #e7147d` with `translate(-2px, -2px)`): hover on paper, small and ink buttons.
- **Ink hairline** (`box-shadow: inset 0 0 0 1px #fffefa14`): edge of ink cards on graphite.
- **Blueprint cell** (`box-shadow: inset 0 0 0 1px #e7147d66` over a #e7147d14 fill): the lit grid cell under the pointer.

### Named Rules
**The Hard Offset Rule.** Shadows are never blurred and never ambient. The only drop shadow is the 4px hard offset on hover, in porcelain or magenta; reduced motion removes both the shift and the shadow.

**The Flat Panel Rule.** Panels are colour fields, not objects. No bevels, gloss, metal, glass, blur or realistic lighting, and no solid 3D renders.

## Shapes

Square and straight. Every panel, card, frame, tab, chip, menu, chapter bar, FAQ control and dot-matrix pixel has 0 radius; buttons alone take 2px. Framed panels (hero frame, scope stage, report card, flow sheet, export listing) carry corner ticks: 10px L-shapes in 2px silver at the top-left and bottom-right corners, sitting 1px outside the edge. The finding is a diamond (a square rotated 45°); list bullets repeat it in graphite at 10px, and the square FAQ control rotates into the same diamond when open. Scope squares (6px magenta) mark the scope line, frame labels and status. Brackets are the recurring silhouette: in the mark and around tags.

## Components

### Buttons
- **Shape:** near-square (2px), 54px tall; 44px for the small nav button.
- **Paper:** porcelain with graphite Goldman label, the hero's primary path; hover turns silver over a magenta hard offset.
- **Primary:** action magenta with porcelain label, 14px 26px, trailing arrow with a 26px gap; hover deepens to action-hover over a porcelain hard offset.
- **Ink:** graphite with porcelain label, used on magenta fields; hover raises to raised over a magenta hard offset.
- **Small:** porcelain with graphite label in the header; hover silver with a magenta offset.
- **Hover / Press:** fine pointers shift −2px/−2px, cast the hard offset and push the arrow 4px over 160ms `cubic-bezier(0.23, 1, 0.32, 1)`; press scales to 0.97. Reduced motion keeps colour changes only.
- **Catch:** every primary path into `/dashboard` carries `data-catch`; hovering it snaps the ASCII mark's brackets shut (spring 0.35s, bounce 0.35).
- **Text link:** porcelain 14px semibold with a 1px silver underline at 44% that turns magenta on hover, 48px tall. **Secondary link:** Goldman 13px uppercase with a trailing arrow, no fill.

### Chips and Tags
- **Bracket tag:** mono 11px uppercase in `[ brackets ]`, naming a real thing (a perspective, a file, the export). Pinned to the corner of the panel it names, muted on ink.
- **Code chips:** mono 12px with a 1px line border, or action-magenta fill for the JSON marker; square.

### Cards / Containers
- **Corner Style:** square (0), with corner ticks when framed.
- **Background:** magenta (display), ink (art and evidence), silver (scope), action (body copy on the magenta family).
- **Shadow Strategy:** flat; ink cards take the inset hairline.
- **Internal Padding:** 32px for workflow cards (24px mobile), clamp(32px, 5vw, 72px) for full-width panels.

### Navigation
A fixed, solid graphite bar, 80px tall (64px mobile), closed by a silver hairline at 21%. Mark-and-wordmark lockup in Goldman 22px uppercase; mono 12px silver links, each led by a 10px pink-ink number (`01 /`, `02 /`, `03 /`, aria-hidden) and turning porcelain on hover; the small porcelain button at the end. Under 760px a square outlined "Menú" toggle opens a square surface panel and Escape closes it.

### Signature: hero frame
A square framed panel (clamp(480px, 40vw, 580px) tall) with a 1px silver hairline and corner ticks, filled with a surface → graphite → ink gradient under a soft magenta glow. It carries the blueprint (30px grid, square and dashed square, crosshair, magenta corner marks) and the ASCII mark. A 2px magenta scan line sweeps top to bottom every 4.8s, linear; a square 44px pause control holds both the scan and the mark's spin. Reduced motion keeps the scan still.

### Signature: flow band
A full-bleed band of four flow links (Subir, Autorizar, Evaluar, Exportar) on a magenta → action gradient, 84px tall (68px mobile), divided by graphite hairlines at 33%. Labels are Goldman graphite with a trailing arrow; hover draws a 4px graphite bar from the left along the bottom edge and nudges the arrow up-right 3px.

### Tabs
A square silver-track bar (6px inset) with a square graphite indicator that slides 300ms `cubic-bezier(.77, 0, .175, 1)`; selected label porcelain with a pink-ink icon. Arrow keys, Home and End move selection.

### Disclosure (FAQ)
Native `details` rows between line hairlines, 84px summaries in 18px semibold body; a 36px square raised control turns signal magenta and rotates 45° into a diamond when open; height animates 240ms.

### Closing card
A full-width square panel on a 125° gradient (magenta to 38%, action at 68%, graphite past the corner) with a graphite and porcelain two-tone headline and an ink button. Beside it a square radar: four 2px porcelain squares widen from the flat mark (scale 0.18 to 1, fading from 70%) on a 4.8s linear loop staggered 1.2s apart; static under reduced motion, half opacity on mobile.

### Signature: the `[◆]` mark
- **ASCII render:** a canvas ray-marches the mark per character cell using the ramp `.:-=+*#%@`: brackets in `#8f8896`/porcelain, finding in action/pink ink, dust in line-soft. It turns toward the pointer (spring 0.5s, bounce 0.15), spins slowly, pauses off screen, in hidden tabs and from the hero control, and paints one still frame under reduced motion. Without JavaScript the flat SVG mark shows instead.
- **Pinned stage:** 360svh of native sticky scroll; the brackets spread under [ Código ] and [ HTTPS ], close, and a full magenta GOTCHU field wipes in from below and out through the top (clip-path, never a translucent tint), handing over to the report card.
- **Stacked fallback:** below 761px wide, below 560px tall, under reduced motion and without JavaScript, the stage renders stacked.

### Dot-matrix pictograms
11×11 grids of square pixels (74% of the cell) in currentColor (magenta by default, porcelain on action cards). Each card gets one dominant pictogram; pixels morph 620ms with a 5ms stagger and shy 220ms from a fine pointer.

## Do's and Don'ts

### Do:
- **Do** keep every panel, card, tab, chip and pixel square (0) and buttons at 2px; frame panels with corner ticks.
- **Do** answer button hover with the hard 4px offset shadow, porcelain on action magenta and magenta on light or ink buttons.
- **Do** put small text on action magenta, graphite, ink or silver, never on signal magenta.
- **Do** run gradients only between brand colours: magenta, action, graphite, surface, ink.
- **Do** move motion graphics in straight lines and squares: scan lines, widening squares, sliding bars.
- **Do** set every display line in Goldman 700 uppercase and every reading line in the platform sans.
- **Do** label with real product vocabulary in mono bracket tags attached to the thing they name.
- **Do** mark every primary path into the product with `data-catch` so the mark catches it.
- **Do** give every moving piece a still equivalent for reduced motion, small or short viewports and no-JS.
- **Do** make art from ASCII and pixels: the ASCII mark, square dot pictograms, the blueprint grid.

### Don't:
- **Don't** round panels, chips or controls, or use pills and circles.
- **Don't** blur a shadow or use ambient, glow-style elevation; don't make the header translucent.
- **Don't** use solid 3D objects, prisms, photos, metal, glass or any realistic render.
- **Don't** add captions or helper copy that explain the artwork or the page.
- **Don't** bring a non-brand hue into a gradient.
- **Don't** show a loader or splash before content.
- **Don't** invent results, metrics, findings, customers or animated pseudo-data; show product structure instead.
- **Don't** set small text on signal magenta (#e7147d) or graphite text on action magenta (#c80c68).
- **Don't** ship or embed AIRNT; Goldman is the licensed face.
- **Don't** use custom cursors, scroll snapping or hijacking, or particles that cover content.
- **Don't** use a bracket tag as a kicker above a section headline.
