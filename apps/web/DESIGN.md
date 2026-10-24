---
name: Gotchu
description: Evidence-first security review, spoken as a near-square brutalist brand board.
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
    fontFamily: "'Gotchu Display', 'Saira', sans-serif"
    fontSize: "clamp(2.3rem, 4vw, 4.25rem)"
    fontWeight: 700
    lineHeight: 1.06
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "'Gotchu Display', 'Saira', sans-serif"
    fontSize: "clamp(2.5rem, 4.6vw, 4.5rem)"
    fontWeight: 700
    lineHeight: 0.98
    letterSpacing: "-0.025em"
  title:
    fontFamily: "'Gotchu Display', 'Saira', sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.005em"
  label:
    fontFamily: "'Gotchu Display', 'Saira', sans-serif"
    fontSize: "14px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.03em"
  body:
    fontFamily: "'Gotchu Text', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.65
  lead:
    fontFamily: "'Gotchu Text', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
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
  pixel: "2px"
  chip: "6px"
  control: "8px"
  inset: "10px"
  panel: "12px"
  sheet: "14px"
  card: "16px"
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
    rounded: "{rounded.control}"
    padding: "14px 26px"
    height: "54px"
  button-paper-hover:
    backgroundColor: "{colors.silver}"
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.porcelain}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "14px 26px"
    height: "54px"
  button-primary-hover:
    backgroundColor: "{colors.action-hover}"
  button-ink:
    backgroundColor: "{colors.graphite}"
    textColor: "{colors.porcelain}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "14px 26px"
    height: "54px"
  button-ink-hover:
    backgroundColor: "{colors.raised}"
  button-small:
    backgroundColor: "{colors.porcelain}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.control}"
    padding: "6px 14px"
    height: "34px"
  button-small-hover:
    backgroundColor: "{colors.silver}"
  header:
    backgroundColor: "{colors.graphite}"
    textColor: "{colors.porcelain}"
    height: "64px"
  card-magenta:
    backgroundColor: "{colors.magenta}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.card}"
    padding: "{spacing.panel-pad}"
  card-ink:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.porcelain}"
    rounded: "{rounded.card}"
    padding: "{spacing.card-pad}"
  card-silver:
    backgroundColor: "{colors.silver}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.card}"
    padding: "{spacing.panel-pad}"
  card-action:
    backgroundColor: "{colors.action}"
    textColor: "{colors.porcelain}"
    rounded: "{rounded.card}"
    padding: "{spacing.card-pad}"
  hero-mark:
    height: "clamp(380px, 58svh, 620px)"
  signal-band:
    backgroundColor: "{colors.magenta}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.none}"
    height: "64px"
  tab-track:
    backgroundColor: "{colors.silver-track}"
    rounded: "{rounded.panel}"
    padding: "6px"
  tab-selected:
    backgroundColor: "{colors.graphite}"
    textColor: "{colors.porcelain}"
    rounded: "{rounded.control}"
    height: "52px"
  report-card:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.silver}"
    rounded: "{rounded.sheet}"
    padding: "16px 22px"
  chip-code:
    textColor: "{colors.porcelain}"
    rounded: "{rounded.chip}"
    padding: "7px 10px"
  chip-json:
    backgroundColor: "{colors.action}"
    textColor: "{colors.porcelain}"
    rounded: "{rounded.chip}"
    padding: "5px 10px"
---

# Design System: Gotchu

## Overview

**Creative North Star: "The Square Brand Board"**

Gotchu speaks like an identity system that also does the job: one bold mark, wide uppercase type, drenched colour fields and technical blueprint detail, all on straight lines with corners only just softened. The geometry stays brutalist (flat fields, hairlines, a hard-edged hover offset) and every corner carries a small, very smooth radius from a fixed scale; nothing becomes a pill or a circle. Art is digital and authored from the world's own materials (the ASCII mark, square dot-matrix pictograms, hairline blueprint grids, square radar motion), never solid 3D objects or realistic renders. Content is real product vocabulary (SHA-256, `_gotchu.<dominio>`, report enums, JSON export keys) and is never padded with invented results.

The mark `[◆]` is two scope brackets closing on a magenta finding. It is the only symbol of the world and carries the signature behaviour: the brackets spread and snap shut. It lives in the hero itself, large and unframed, over the blueprint grid. The interface stays clean: few elements, each at full size, with no captions explaining the artwork.

The landing tokens are scoped to `.g-page`; customer and demo surfaces keep their own styles until they are deliberately moved into this world.

**Key Characteristics:**
- Graphite ground, magenta display fields, silver and ink panels, porcelain type.
- One Saira variable file in two faces: Gotchu Display (125% width, 700, uppercase) for everything that speaks, Gotchu Text (100% width) for reading; ui-monospace for tags, nav and numbers.
- Near-square geometry: a small radius scale from 2px pixels to 16px section cards; flat fields and hairlines; a hard-edged, translucent 4px offset on hover.
- ASCII and pixel art only: the ASCII mark, 11×11 dot pictograms, blueprint grids.
- Motion moves in straight lines and squares (scan lines, widening square radar, sliding bars); every moving piece has a still equivalent.

## Colors

Four brand colours (graphite, magenta, porcelain, silver) on a tonal graphite ladder, with a darker magenta that carries small text.

### Primary
- **Signal Magenta** (magenta): the display field. Fills the flow band and closing card, the GOTCHU flash, the finding in the mark, dot pictograms, the accent clause of the hero headline, chapter progress bars, the hero scan line, glow and blueprint hover cell, the open FAQ control, the text-link hover underline, and (at 80%) the hover offset on light and ink buttons.
- **Action Magenta** (action): every surface where small text meets the magenta family: the primary button, the history card, JSON and code chips, text selection, the ASCII finding's shadow side, and the far end of every magenta gradient. Hover deepens to action-hover.
- **Pink Ink** (accent-ink): magenta as text on dark: nav numbers, stage-headline accents, DNS step numerals, export link, selected-tab icon, FAQ summary hover, the lit face of the ASCII finding.

### Neutral
- **Graphite** (graphite): page ground and the solid header, ink buttons, type on magenta and silver, the dark end of the closing gradient.
- **Ink** (ink): darkest panel: scope stage, workflow cards, report card, flow sheets. Ink cards carry a 1px inset porcelain hairline at 8%.
- **Surface / Raised** (surface, raised): mobile menu panel, sheet footers, FAQ control at rest, ink-button hover.
- **Line / Line-soft** (line, line-soft): hairlines, dividers, outlined chips and the menu toggle; line-soft also fills the ASCII dust and unlit chapter bars.
- **Porcelain** (porcelain): headings on dark, the paper and small buttons, blueprint lines and plus marks, the radar squares, and (at 25%) the hover offset on the primary button.
- **Silver** (silver): body copy on dark, the header hairline (21%), the text-link underline (33%), the hero foot rule and icons, and the silver panel. On silver, body copy is on-silver and the tab track is silver-track.
- **Muted** (muted): tags inside ink cards, idle chapter headings, the hero scope list, mark labels and pause control.
- **Focus** (focus): 2px outline, 4px offset, on every focusable element.

### Named Rules
**The Small-Text Rule.** Small text never sits on signal magenta (porcelain reaches only about 4.4:1, graphite about 4:1) and graphite never sits on action magenta (about 3.1:1). Magenta takes display type, graphic marks and fields; a card that needs body copy switches to action magenta with porcelain text, or puts the text on graphite.

**The Brand Gradient Rule.** Gradients run only between brand colours: magenta to action (flow band, 100°), magenta to action to graphite (closing card, 125°), a faint radial magenta glow fading to transparent (hero), magenta fading out at both ends (scan line), silver fading along a hairline (hero foot rule). No other hue ever enters a gradient.

**The Two-Tone Headline Rule.** On magenta and silver fields a headline is graphite with its last clause in porcelain; on dark, porcelain with the accent clause in signal magenta at hero size or pink ink at section size.

## Typography

**Display Font:** Gotchu Display: Saira variable fixed at 125% width (self-hosted OFL, `public/fonts/saira-latin.woff2`), falling back to Saira then sans-serif
**Body Font:** Gotchu Text: the same Saira file at 100% width, falling back to the platform sans
**Label/Mono Font:** ui-monospace

**Character:** a wide grotesque shouting in uppercase over its own normal-width cut; mono tags and numbers read like the labels on a technical drawing.

### Hierarchy
- **Display** (700, clamp(2.3rem, 4vw, 4.25rem), 1.06, uppercase): hero headline only, two lines; mobile clamp(2rem, 9.6vw, 3rem). Bigger relatives: the GOTCHU flash clamp(6rem, 19vw, 20rem), the closing headline clamp(2.6rem, 6vw, 6.4rem)/0.92 and the footer wordmark clamp(3.6rem, 15.5vw, 16rem) at -0.035em.
- **Headline** (700, clamp(2.5rem, 4.6vw, 4.5rem), 0.98, uppercase, max 14ch): section headings; 36px on mobile. Stage headings clamp(2.25rem, 4.4vw, 4.25rem)/1.
- **Title** (700, 22–26px, 1.1, uppercase): card and sheet titles; chapter headings clamp(2.1rem, 3.6vw, 3.4rem)/1.
- **Label** (700, 14px, 0.03em, uppercase): button text (12px on the small button), secondary links (13px), tabs (15px), report terms; flow-band verbs run clamp(1.2rem, 1.7vw, 1.5rem) at 0.04em.
- **Body** (400, 16px, 1.65): reading copy in silver; the hero lead 16px/1.8 at 460px; section leads 17–18px/1.7 at 420–580px measure; FAQ summaries 600 18px.
- **Tag** (600, 11px, 0.1em, uppercase mono): `[ bracketed ]` labels naming real things; the hero mark labels and hero foot run at 10px.
- **Nav** (600, 12px, 0.08em, uppercase mono): header links, with 10px pink-ink numbers.
- **Code** (14px/1.95 mono): export listing with gutter line numbers; DNS record at 18px.

### Named Rules
**The Two-Width Rule.** Both faces come from one variable file: Display is always 125% width, 700 and uppercase, with negative tracking at headline sizes and positive tracking at label sizes; Text is 100% width for every reading line. Reading copy is never set in the display cut.

**The Licence Rule.** AIRNT is a visual reference only. Ship Saira (OFL, licence file alongside the woff2); never embed or distribute AIRNT without licence evidence.

## Layout

The header is a fixed 64px bar at every width. The hero fills the first viewport (max(640px, 100svh − 64px)) inside a 1480px wrap with clamp(20px, 4.2vw, 68px) gutters: copy at 1fr beside the ASCII mark at 1.05fr (gap 24px), the mark clamp(380px, 58svh, 620px) tall and bleeding into the right gutter. A foot row closes the hero under a fading silver hairline: the four scope items on the left, the pause control on the right. A full-bleed four-column magenta flow band follows. Below 1050px the hero stacks (mark 380px) and the band becomes 2×2; below 760px the hero sizes to content, the mark drops to 300px and the foot stacks.

Lower sections use a container of min(1180px, 100% − 112px), narrowing to 100% − 64px under 1050px and 100% − 40px under 760px. Full-width panels (perspectives, closing) sit 12px in from the viewport (8px on mobile); workflow cards sit 12px apart. Sections breathe at 120–140px vertical (72–80px mobile).

The blueprint grid is a 96px hairline lattice (porcelain at 6%) with plus marks at the crossings (porcelain at 32%), masked to fade at the top and bottom 10%; in the hero it is masked radially around the mark (ellipse 70% × 80% at 70% 45%). Under a fine pointer the 96px cell beneath lights magenta and follows it.

## Elevation & Depth

Flat surfaces with a brutalist hover. Depth at rest comes from tonal panels (ink below graphite below raised) and hairlines; the hero's only atmosphere is a faint radial magenta glow behind the mark. The header is a solid graphite bar with a silver hairline at 21%; nothing is translucent or blurred. On a fine pointer, buttons answer hover by shifting up-left 2px over an unblurred, translucent 4px offset.

### Shadow Vocabulary
- **Offset, porcelain** (`box-shadow: 4px 4px 0 #fffefa40` with `translate(-2px, -2px)`): hover on the action-magenta primary button.
- **Offset, magenta** (`box-shadow: 4px 4px 0 #e7147dcc` with `translate(-2px, -2px)`): hover on paper, small and ink buttons.
- **Ink hairline** (`box-shadow: inset 0 0 0 1px #fffefa14`): edge of ink cards on graphite.
- **Blueprint cell** (`box-shadow: inset 0 0 0 1px #e7147d66` over a #e7147d14 fill): the lit grid cell under the pointer.

### Named Rules
**The Hard Offset Rule.** Shadows are never blurred and never ambient. The only drop shadow is the 4px hard-edged offset on hover, porcelain at 25% or magenta at 80%; reduced motion removes both the shift and the shadow.

**The Flat Panel Rule.** Panels are colour fields, not objects. No bevels, gloss, metal, glass, blur or realistic lighting, and no solid 3D renders.

## Shapes

Near-square and straight. Corners take a small, very smooth radius from a fixed scale that grows with the size of the thing: 2px for dot-matrix pixels and chapter progress bars, 6px for chips and badges, 8px for buttons, tabs, the menu toggle and the FAQ control, 10px for the DNS record inset, 12px for the export listing, tab track and mobile menu panel, 14px for the report card and flow sheets, 16px for section cards. Full-bleed bands, the blueprint cells and the radar squares stay at 0. Panels are framed only by hairlines. The finding is a diamond (a square rotated 45°); list bullets repeat it in graphite at 10px, and the FAQ control rotates into the same diamond when open. Brackets are the recurring silhouette: in the mark and around tags.

### Named Rules
**The Small Radius Rule.** Radius never exceeds 16px and always comes from the scale; a radius exists to soften a corner, not to change the silhouette. No pills, no circles.

## Components

### Buttons
- **Shape:** gently softened (8px), 48px tall on desktop and 34px on mobile; 34px for the small header button.
- **Paper:** porcelain with graphite display label, the hero's primary path; hover turns silver over the magenta offset.
- **Primary:** action magenta with porcelain label, 14px 26px, trailing SVG arrow with a 26px gap; hover deepens to action-hover over the porcelain offset.
- **Ink:** graphite with porcelain label, used on magenta fields; hover raises to raised over the magenta offset.
- **Small:** porcelain with graphite 12px label, 8px 16px, in the header; hover silver with the magenta offset.
- **Hover / Press:** fine pointers shift −2px/−2px, cast the offset and push the arrow 4px over 160ms `cubic-bezier(0.23, 1, 0.32, 1)`; press scales to 0.97. Reduced motion keeps colour changes only.
- **Catch:** every primary path into `/dashboard` carries `data-catch`; hovering it snaps the ASCII mark's brackets shut (spring 0.35s, bounce 0.35).
- **Text link:** porcelain 14px semibold over a 1px silver underline at 33% that turns magenta on hover, 34px tall. **Secondary link:** display 13px uppercase with a trailing SVG arrow, no fill.

### Chips and Tags
- **Bracket tag:** mono 11px uppercase in `[ brackets ]`, naming a real thing (a perspective, a file, the export). Pinned to the corner of the panel it names, muted on ink.
- **Code chips:** mono 12px with a 1px line border at 6px radius; action-magenta fill for the JSON marker and the sheet-footer record.

### Cards / Containers
- **Corner Style:** section cards 16px; sheets and the report card 14px; insets 10–12px.
- **Background:** magenta (display), ink (art and evidence), silver (scope), action (body copy on the magenta family).
- **Shadow Strategy:** flat; ink cards take the inset hairline, sheets a 1px line border.
- **Internal Padding:** 32px for workflow cards (24px mobile), clamp(32px, 5vw, 72px) for full-width panels.

### Navigation
A fixed, solid graphite bar, 52px tall (48px on mobile), closed by a silver hairline at 21%. Mark-and-wordmark lockup in display 19px uppercase (18px on mobile); mono 12px silver links, each led by a 10px pink-ink number (`01 /`, aria-hidden) that hides below 1180px, turning porcelain on hover; the 34px small porcelain button at the end. Below 960px an outlined 8px "Menú" toggle opens a 12px-radius surface panel and Escape closes it.

### Signature: hero field
No frame: the hero is the field. The blueprint grid fills it under a radial mask centred on the mark, with the pointer-following magenta cell; a faint radial magenta glow (14%) sits behind the mark. The ASCII mark stands large on the right with no labels; the copy column carries only the headline, one lead sentence and the two actions. A 1px magenta scan line (55% opacity, fading at both ends) sweeps the whole hero top to bottom every 7s on `cubic-bezier(.77, 0, .175, 1)`. The hero foot carries the scope list (14px silver SVG icons, mono 10px muted) and a quiet text control, "Pausar" / "Reanudar" with a 12px glyph-free SVG play/pause, 44px tall, that holds both the scan and the mark's spin. Reduced motion keeps the scan still.

### Signature: flow band
A full-bleed band of four flow links (Subir, Autorizar, Evaluar, Exportar) on a magenta → action gradient, 64px tall, divided by graphite hairlines at 25%. Labels are display graphite, left-aligned, with the arrow pushed to the right edge; hover draws a 3px graphite bar from the left along the bottom edge and nudges the arrow up-right 3px.

### Tabs
A silver-track bar (12px radius, 6px inset) with a graphite indicator (8px radius) that slides 300ms `cubic-bezier(.77, 0, .175, 1)`; selected label porcelain with a pink-ink icon. Arrow keys, Home and End move selection.

### Disclosure (FAQ)
Native `details` rows between line hairlines, 84px summaries in 18px semibold text face; a 36px raised control (8px radius) turns signal magenta and rotates 45° into a diamond when open; height animates 240ms.

### Closing card
A full-width 16px-radius panel on a 125° gradient (magenta to 38%, action at 68%, graphite past the corner) with a graphite and porcelain two-tone headline and an ink button. Beside it a square radar: four 2px porcelain squares widen from the flat mark (scale 0.18 to 1, fading from 70%) on a 4.8s linear loop staggered 1.2s apart; static under reduced motion, half opacity on mobile.

### Signature: the `[◆]` mark
- **ASCII render:** a canvas ray-marches the mark per character cell using the ramp `.:-=+*#%@`: brackets in `#8f8896`/porcelain, finding in action/pink ink, dust in line-soft. It turns toward the pointer (spring 0.5s, bounce 0.15), spins slowly, pauses off screen, in hidden tabs and from the hero control, and paints one still frame under reduced motion. Without JavaScript the flat SVG mark shows instead.
- **Pinned stage:** 360svh of native sticky scroll; the brackets spread under [ Código ] and [ HTTPS ], close, and a full magenta GOTCHU field wipes in from below and out through the top (clip-path, never a translucent tint), handing over to the report card.
- **Stacked fallback:** below 761px wide, below 560px tall, under reduced motion and without JavaScript, the stage renders stacked.

### Dot-matrix pictograms
11×11 grids of 2px-radius pixels (74% of the cell) in currentColor (magenta by default, porcelain on action cards). Each card gets one dominant pictogram; pixels morph 620ms with a 5ms stagger and shy 220ms from a fine pointer.

## Do's and Don'ts

### Do:
- **Do** size every control at 34px minimum (`--g-control`): header button, mobile buttons, links, tabs, menu toggle and pause. Desktop primary buttons are 48px. 34px stays above WCAG 2.2 AA's 24px target size; keep 8px or more between adjacent controls.
- **Do** take every radius from the scale: 2px pixels and bars, 6px chips, 8px controls, 10–14px panels, 16px section cards.
- **Do** answer button hover with the hard-edged 4px offset, porcelain at 25% on action magenta and magenta at 80% on light or ink buttons.
- **Do** put small text on action magenta, graphite, ink or silver, never on signal magenta.
- **Do** run gradients only between brand colours: magenta, action, graphite, silver, surface, ink.
- **Do** move motion graphics in straight lines and squares: scan lines, widening squares, sliding bars.
- **Do** set every display line in Gotchu Display 700 uppercase and every reading line in Gotchu Text.
- **Do** label with real product vocabulary in mono bracket tags attached to the thing they name.
- **Do** draw arrows and icons as inline SVG.
- **Do** mark every primary path into the product with `data-catch` so the mark catches it.
- **Do** give every moving piece a still equivalent and a visible pause where it loops in the first viewport.
- **Do** make art from ASCII and pixels: the ASCII mark, dot pictograms, the blueprint grid.

### Don't:
- **Don't** use pills, circles or any radius above 16px.
- **Don't** blur a shadow or use ambient, glow-style elevation; don't make the header translucent.
- **Don't** frame the hero mark in a panel or add corner ticks.
- **Don't** use solid 3D objects, prisms, photos, metal, glass or any realistic render.
- **Don't** add captions or helper copy that explain the artwork or the page.
- **Don't** bring a non-brand hue into a gradient.
- **Don't** show a loader or splash before content.
- **Don't** invent results, metrics, findings, customers or animated pseudo-data; show product structure instead.
- **Don't** set small text on signal magenta (#e7147d) or graphite text on action magenta (#c80c68).
- **Don't** ship or embed AIRNT; Saira is the licensed face.
- **Don't** use custom cursors, scroll snapping or hijacking, or particles that cover content.
- **Don't** put a tag or mono line above a headline as a kicker.
