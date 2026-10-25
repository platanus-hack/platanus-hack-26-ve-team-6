---
name: Gotchu
description: Evidence-first security review, set as an annotated dossier on a pure white or pure black ground.
colors:
  magenta: "#e7147d"
  action: "#c80c68"
  pink-ink: "#ff8fbe"
  graphite: "#191923"
  porcelain: "#fffefa"
  silver: "#c7bfbd"
  white: "#ffffff"
  black: "#000000"
  slate: "#646174"
  mist: "#b5b1bb"
  line-dark: "#3d3b4c"
  muted-light: "#f6f4f5"
  muted-dark: "#0e0e12"
  popover-dark: "#0d0d10"
  dust-light: "#e6e1df"
  dust-dark: "#24232c"
typography:
  display-hero:
    fontFamily: "'Gotchu Display', sans-serif"
    fontSize: "clamp(46px, 7.4vw, 124px)"
    fontWeight: 700
    lineHeight: 0.9
    letterSpacing: "-0.015em"
  display:
    fontFamily: "'Gotchu Display', sans-serif"
    fontSize: "clamp(36px, 5.6vw, 88px)"
    fontWeight: 700
    lineHeight: 0.94
    letterSpacing: "-0.015em"
  headline:
    fontFamily: "'Gotchu Display', sans-serif"
    fontSize: "clamp(28px, 4.4vw, 64px)"
    fontWeight: 700
    lineHeight: 1.02
    letterSpacing: "-0.015em"
  title:
    fontFamily: "'Gotchu Display', sans-serif"
    fontSize: "clamp(18px, 1.9vw, 24px)"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.005em"
  question:
    fontFamily: "'Gotchu Display', sans-serif"
    fontSize: "clamp(20px, 2.3vw, 30px)"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.01em"
  lead:
    fontFamily: "'Gotchu Text', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "clamp(19px, 1.7vw, 22px)"
    fontWeight: 400
    lineHeight: 1.5
  body:
    fontFamily: "'Gotchu Text', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.65
  control:
    fontFamily: "'Gotchu Text', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1
  nav:
    fontFamily: "'Gotchu Text', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: 1
  note:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "0.14em"
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "14.5px"
    fontWeight: 400
    lineHeight: 1.75
  record:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "clamp(17px, 5.4vw, 52px)"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.02em"
rounded:
  none: "0px"
  pixel: "2px"
  chip: "6px"
  control: "8px"
  panel: "12px"
  sheet: "14px"
  card: "16px"
spacing:
  gutter: "clamp(20px, 4vw, 48px)"
  page-max: "1400px"
  header: "52px"
  header-mobile: "48px"
  section-y: "clamp(48px, 6vw, 88px)"
  title-gap: "clamp(36px, 5vw, 72px)"
  note-column: "220px"
  note-gap: "48px"
  control-gap: "12px"
components:
  button-primary:
    backgroundColor: "{colors.graphite}"
    textColor: "{colors.white}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 22px"
    height: "48px"
  button-primary-dark:
    backgroundColor: "{colors.porcelain}"
    textColor: "{colors.black}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 22px"
    height: "48px"
  button-primary-lg:
    backgroundColor: "{colors.graphite}"
    textColor: "{colors.white}"
    rounded: "{rounded.control}"
    padding: "0 28px"
    height: "56px"
  button-small:
    backgroundColor: "{colors.graphite}"
    textColor: "{colors.white}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "34px"
  button-outline:
    backgroundColor: "{colors.white}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "34px"
  button-outline-hover:
    backgroundColor: "{colors.muted-light}"
  button-link:
    textColor: "{colors.graphite}"
    typography: "{typography.control}"
    rounded: "{rounded.pixel}"
  button-link-hover:
    textColor: "{colors.action}"
  toggle:
    textColor: "{colors.slate}"
    rounded: "{rounded.control}"
    size: "34px"
  toggle-pressed:
    backgroundColor: "{colors.graphite}"
    textColor: "{colors.white}"
  accordion-control:
    textColor: "{colors.graphite}"
    rounded: "{rounded.control}"
    size: "34px"
  accordion-control-open:
    backgroundColor: "{colors.action}"
    textColor: "{colors.white}"
  header:
    backgroundColor: "{colors.white}"
    textColor: "{colors.graphite}"
    height: "{spacing.header}"
  sheet-menu:
    backgroundColor: "{colors.white}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.none}"
    padding: "12px 20px 20px"
  highlight-body:
    backgroundColor: "{colors.pink-ink}"
    textColor: "{colors.graphite}"
  highlight-body-dark:
    backgroundColor: "{colors.action}"
    textColor: "{colors.porcelain}"
  highlight-big:
    backgroundColor: "{colors.magenta}"
    textColor: "{colors.porcelain}"
  json-exhibit:
    textColor: "{colors.graphite}"
    typography: "{typography.code}"
    rounded: "{rounded.chip}"
    padding: "18px 0"
  footer:
    backgroundColor: "{colors.graphite}"
    textColor: "{colors.porcelain}"
    padding: "56px 48px"
---

# Design System: Gotchu

## Overview

**Creative North Star: "The Annotated Dossier"**

Gotchu reads like a case file someone has already worked through with a pen: giant wide uppercase headlines that unmask line by line, a highlighter swept across the phrases that matter, numbered margin notes beside the paragraphs they qualify, hairline rules between entries, and a few plates of authored art. The ground is a complete white or a complete black and nothing sits on it as a panel; structure comes from rules, columns and type size, not from cards. The brand speaks through magenta used sparingly as ink and highlighter, never as a filled section.

Art is digital and made of the world's own materials: dot fields of square pixels and glyphs on canvas (the `[◆]` mark in the hero and the closing GOTCHU wordmark). The finding diamond `◆` is the only coloured glyph. The fields ripple away from a fine pointer, gather on their finding while a primary action is hovered or focused, and hold still when paused. Content is real product vocabulary (SHA-256, requested HTTPS profiles, report JSON keys) and is never padded with invented results.

The whole app (landing, `/dashboard`, `/setup`, `/privacy`, `/terms`) follows a light, dark or system theme. Every rule below holds in both; values are shadcn tokens on page roots that carry the `.gl` class, loaded once from the root route. App CSS lives in `src/components/customer-shell.css` (shared primitives), `customer-report.css` and `customer-operations.css`.

**Key Characteristics:**
- Pure white (light) or pure black (dark) ground; graphite or porcelain ink; magenta as highlighter, bullet, rule and finding.
- One Saira variable file in two faces: Gotchu Display (125% width, 700, uppercase) for headlines, Gotchu Text (100% width) for reading and controls; ui-monospace for notes, labels and code.
- Editorial devices: line-unmask headlines, highlighter marks, superscript references to margin notes, drop cap, dotted leaders, 2px section rules.
- shadcn/ui controls on Base UI, restyled: 8px corners, 34px floor, a hard magenta offset on hover.
- Square-pixel dot fields only; every moving piece has a still state and a visible pause.

## Colors

Four brand colours (magenta, graphite, porcelain, silver) over two absolute grounds, with the action shade and pink ink carrying magenta wherever it meets small text.

### Primary
- **Signal Magenta** (magenta): the brand mark in both themes. The band behind large highlighted phrases (with porcelain type), list diamonds, the left rule of mobile margin notes, the 2px nav hover underline, the link hover underline, the button hover offset and the finding in dot fields. Never behind small text.
- **Action Magenta** (action): magenta for small text and marks on white: superscript references, JSON keys, item numerals, the open FAQ control and link hover text. In dark it becomes the body highlighter band under porcelain text.
- **Pink Ink** (pink-ink): the light-theme body highlighter band under graphite text and text selection; in dark it takes over every action-magenta role (references, keys, open FAQ control) because action is too dark on black.

### Neutral
- **White / Black** (white, black): the ground, cards and header of the light and dark themes respectively. Also the page behind the landing, so overscroll never shows another colour.
- **Graphite** (graphite): light-theme ink: type, the primary button, pressed toggles, and the light-theme footer band.
- **Porcelain** (porcelain): dark-theme ink and primary button; type on the magenta band in both themes; footer type.
- **Silver** (silver): light-theme hairlines and input borders; mid dot tone in dark.
- **Slate / Mist** (slate, mist): muted text (notes, labels, idle toggles, code line numbers, dotted leaders) in light and dark.
- **Line Dark** (line-dark): dark-theme hairlines and borders.
- **Muted Light / Muted Dark / Popover Dark**: outline-button hover fill and the dark menu sheet surface.
- **Dust** (dust-light, dust-dark): the faintest dot tone, the ambient dust of the fields.

### Named Rules
**The Small-Text Rule.** Small text never sits on signal magenta (#e7147d). Magenta takes display type, marks, rules and fields; small magenta text uses action on white and pink ink on black; body highlights use pink ink behind graphite (light) or action behind porcelain (dark).

**The Two Grounds Rule.** The light ground is #ffffff and the dark ground is #000000, never graphite. Graphite survives only as light-theme ink and the light-theme footer band.

**The Highlighter Rule.** Magenta enters the page as a stroke, not a field: a band behind a phrase, a 2px underline, an 8px diamond, a 2px rule. There are no magenta section fills and no gradients between colour fields.

## Typography

**Display Font:** Gotchu Display: Saira variable at 125% width (self-hosted OFL, `public/fonts/saira-latin.woff2`)
**Body Font:** Gotchu Text: the same file at 100% width, falling back to the platform sans
**Label/Mono Font:** ui-monospace

**Character:** a wide grotesque shouting in uppercase over its own normal-width cut, annotated in monospace like marginalia in a case file.

### Hierarchy
- **Display hero** (700, clamp(46px, 7.4vw, 124px), 0.9, uppercase): the two-line h1; the second line carries the big highlighter.
- **Display** (700, clamp(36px, 5.6vw, 88px), 0.94, uppercase, max 16ch): every section headline, two lines. The closing runs four lines at full width: the question, then “we Gotchu.” on the big highlighter after a 0.45em pause.
- **Headline** (700, clamp(28px, 4.4vw, 64px), 1.02, uppercase): glossary terms; scope column names run clamp(34px, 4vw, 56px)/1.
- **Title** (700, clamp(18px, 1.9vw, 24px), 1.1, uppercase): ruled list items; footer line clamp(22px, 3vw, 40px).
- **Question** (600, clamp(20px, 2.3vw, 30px), 1.1, uppercase display): FAQ triggers.
- **Lead** (400, clamp(19px, 1.7vw, 22px), 1.5, max 36ch): the hero sentence.
- **Body** (400, 18px, 1.65, max 62ch): reading copy; two columns from 700px where the block calls for it, opening on a display drop cap at 4.3em. Page base 17px/1.6; scope column titles 600 20px.
- **Control** (600, 14.5px on mobile, 16px from md, 17px on large buttons): button and link text in the text face, sentence case. Nav links 500 15px.
- **Note** (400, 12.5px, 1.55, mono, muted): margin notes, led by a bold superscript number and a bold foreground phrase.
- **Label** (500, 12.5px, 0.14em, uppercase mono, muted): the heading of a ruled list; item letters and numerals use the same mono.
- **Code** (mono 400 14.5px/1.75): the JSON exhibit with gutter line numbers.

### Named Rules
**The Two-Width Rule.** Display is always 125% width, 700 and uppercase with slight negative tracking; every reading line and every control label is in the 100% text face. Reading copy is never set in the display cut.

**The Licence Rule.** AIRNT is a visual reference only. Ship Saira (OFL, licence file alongside the woff2); never embed or distribute AIRNT without licence evidence.

## Layout

One centred column, max 1400px, with clamp(20px, 4vw, 48px) gutters. The header is fixed, 52px (48px under 760px), and tucks up while scrolling down past 160px, returning on any scroll up or when it holds focus. It stays visible while the modal mobile menu is open.

The hero is copy beside the dot-field mark from 1000px (1.25fr / 1fr, min-height min(860px, 100svh − header)); the field bleeds into the right gutter at a 520px minimum. Below 1000px the field stacks under the copy at clamp(280px, 70vw, 420px) and bleeds into both gutters. The hero pause control sits on the field's bottom-right at the gutter.

Each section opens on a 2px foreground rule with clamp(48px, 6vw, 88px) vertical padding and a display headline clamp(36px, 5vw, 72px) above its content. Prose blocks put margin notes in a 220px column 48px to the right from 1100px; below that, notes fall inline under the paragraph with a 2px magenta left rule. Plates sit in a split (art at auto width beside a ruled list) from 900px. Scope is three columns divided by hairlines from 900px; the team list is three columns from 900px. The closing dot wordmark bleeds into both gutters at clamp(140px, 24vw, 340px).

The Vigilancia section explains periodic re-checks every 1–24 hours, their authorized sources and the service and server events that add context. Checks are periodic; configured email and signed HTTPS webhooks deliver notifications with visible status. An alert does not confirm an attack.

Breakpoints that change layout: 520px (theme switch leaves the header for the menu), 700px (two text columns), 760px (header height), 900px (inline nav vs. menu, splits, scope and team columns), 1000px (hero split), 1100px (margin-note column).

## Elevation & Depth

Flat. Nothing at rest casts a shadow; depth is hairlines, rules and type scale on a single ground. The header is a solid ground-coloured bar with a 1px border, never translucent or blurred. The attached mobile menu panel opens directly below it over a black/40 backdrop that starts below the header, with no blur or shadow. The only drop shadow in the system is the hover answer on filled buttons.

### Shadow Vocabulary
- **Hard magenta offset** (`box-shadow: 4px 4px 0 #e7147d` with `translate(-2px, -2px)`, 160ms `cubic-bezier(.23, 1, .32, 1)`): hover on primary and secondary buttons, both themes.

### Named Rules
**The Hard Offset Rule.** Shadows are never blurred and never ambient. The 4px solid magenta offset appears only as a response to hover on a filled button; reduced motion removes the shift.

**The Flat Ground Rule.** Content sits on the ground, not on panels. No bevels, gloss, metal, glass, blur, realistic lighting or solid 3D renders.

## Shapes

Near-square and straight. Corners come from a fixed scale: 2px for pixels, 6px for chips and the JSON exhibit frame, 8px for buttons, toggles, the FAQ control and the skip link, 12–16px reserved for panels and cards. Sections, the header, the top sheet and the dot fields stay square. Rules carry the structure: 2px foreground rules open sections and close the glossary; 1px hairlines separate list rows, scope columns and FAQ rows; 2px dotted leaders join glossary terms to their definitions. The finding is a diamond (a square rotated 45°): 8px magenta list bullets, the packet and corner marker in the audit diagrams, and the FAQ control rotating into it when open. Dot fields draw square pixels, never round dots.

### Named Rules
**The Small Radius Rule.** Radius never exceeds 16px and always comes from the scale; a radius softens a corner, it does not change the silhouette. No pills, no circles (badges map to 6px).

## Components

shadcn/ui (style `base-nova` on Base UI), restyled in `src/components/ui/`. Navigation styled as a button is a real `<a>` with `buttonVariants`, so it announces as a link.

### Buttons
- **Shape:** 8px corners; 34px tall on mobile, 48px from md; large 56px from md; small and icon 34px at every width.
- **Primary:** foreground fill with ground-coloured text (graphite/white in light, porcelain/black in dark), 600 text face, trailing 16px lucide arrow.
- **Hover / Press:** up-left 2px over the hard 4px magenta offset, arrow nudges 4px right, 160ms; press scales to 0.97; keyboard focus changes the border colour (brand ink in both themes).
- **Outline:** border-colour hairline on the ground; hover darkens the border to foreground and fills muted. Used by the Menú trigger and the sheet's close button.
- **Link:** no fill, foreground text over a 2px underline at .28em; hover turns text action/pink ink and the underline magenta, arrow nudges right.
- **Catch:** every primary path into `/dashboard` carries `data-catch`; hovering or focusing it pulls the dot fields toward their finding.

### Theme switch (DropdownMenu)
One 34px outline icon button (sun, moon or monitor for the current choice, labelled "Tema") opens a menu with Claro, Oscuro and Sistema: icon, label and a check on the selected one. The popup is a flat popover (`--popover` ground, 1px border, 8px radius, no blur, no soft shadow); items are 34px, `--muted` on highlight, and arrow keys, Enter and Escape work as in any menu. Selecting closes it. Applied before paint from `localStorage` key `gotchu-theme`; without JS, `prefers-color-scheme` decides.

### Pause (Toggle)
A 34px outline toggle on the ground with a 12px play/pause icon, bottom-right of the hero field; pressed fills with foreground. It holds every dot field on the page. It renders only when motion is allowed.

### Disclosure (Accordion)
Rows between 1px foreground rules, 22px vertical padding, display uppercase questions that turn action/pink ink on hover. A 34px 8px-radius outlined control holds a plus; when open it rotates 45° into the diamond, fills with action (pink ink in dark) and the plus counter-rotates into a cross, 300ms. Answers are body text at 17.5px, max 60ch.

### Navigation
A fixed, solid header in the ground colour with a 1px bottom border; brand lockup (26px mark plus "GOTCHU" in display 18px at 0.08em). From 900px: two text links (500 15px) whose 2px magenta underline grows from the left on hover, then the theme switch and a small primary button. Below 900px a 34px outline "Menú" button opens the shipped modal menu attached below the header: its fixed-height header replica holds the "Cerrar" control, followed by square, ground-coloured 48px link rows between hairlines and a footer row with the theme switch and primary button. A black/40 backdrop begins below the header. Escape, backdrop and link clicks close it; focus stays inside and returns to the trigger.

### Highlighter
- **Body:** pink-ink band (action in dark) at 0.82em height behind running text, which takes the band's foreground colour; sweeps in left to right over 700ms `cubic-bezier(.65, 0, .35, 1)` when it scrolls into view, staggered within a block.
- **Big:** a magenta band at 0.78em behind display type, which flips to porcelain exactly where the band has passed; accents and descenders outside the band keep the ink colour. Sweeps on load in the hero (650ms delay), on reveal in sections, and only on hover or focus in scope columns. Forced colours drop it to plain text.

### Margin notes
Mono 12.5px muted notes, led by a superscript number in action/pink ink that matches a superscript reference in the paragraph. From 1100px they sit in the right column under a 1px hairline and slide in 12px over 500ms; below, they follow the paragraph with a 2px magenta left rule.

### Display headlines
Each line unmasks upward from a clip (800ms `cubic-bezier(.23, 1, .32, 1)`, 90ms stagger, 0.3em rise). The hero reveals on load; sections reveal on entering the viewport. Content is present without JS and under reduced motion.

### Plates
- **Dot fields:** canvas plates of square pixels and mono glyphs in six theme tones (`--dot-1` to `--dot-6`). Particles fly in on first view, ripple from a fine pointer within 120px, gather on `data-catch`, and sleep off screen, in hidden tabs, when paused and under reduced motion (which paints the settled frame). No React state per frame.

### Por dentro, Por fuera and evidence
The landing is marketing, not a manual: it sells what you get, not every step. The hero lead states the promise ("Todo tu proyecto bajo la lupa: tu código por dentro y tu web por fuera."); never promise complete protection. Two sections follow, "Por dentro. Tu código." and "Por fuera. Tu web.", each a split of a dot field (`code`, then `globe`, mirrored to the other side from 900px) beside a one-sentence lead, four benefits (magenta diamond, display title, one muted line) and a primary action to `/registro`. "Cada hallazgo. Con su prueba." pairs the `report` field with four terms (Evidencia, Severidad, Confianza, Cobertura) whose big highlighter sweeps in turn.

Parallax moves the elements themselves, in the normal page flow (nothing pins). Each section with motion carries `--gl-q`, its distance from the viewport centre (-1 → 1), written by `useParallax` without React renders. Headline lines slide in from the right at two speeds and settle at the centre, `data-depth` dot fields rise faster than the text, a magenta scan line with a faint wake sweeps each side's field top to bottom, and the benefits cascade in from the field's side, each from further out, while their diamonds turn into place. Without motion everything sits still in place.

### Ruled lists and exhibits
- **Ruled list:** rows between 1px hairlines; display uppercase items led by a mono letter, or text-face facts led by the 8px magenta diamond.
- **Glossary:** display terms carrying the big highlighter, a dotted leader, right-aligned definitions, closed by a 2px rule.
- **JSON exhibit:** a 1px foreground frame at 6px radius, mono 14.5px/1.75 with 4ch gutter line numbers behind a hairline, keys in action/pink ink; scrolls horizontally and is focusable.

### Footer
A band in graphite (light) or black (dark) with porcelain type: brand lockup, a display uppercase line and a porcelain link that turns pink ink on hover.

## Do's and Don'ts

### Do:
- **Do** size every control at 34px minimum: header buttons, menu trigger, toggles, the FAQ control, links and pause. Desktop primary buttons are 48px, large ones 56px. Keep 8px or more between adjacent controls.
- **Do** keep the light ground #ffffff and the dark ground #000000, with every colour taken from the `.gl` tokens so both themes share each rule.
- **Do** take every radius from the scale: 2px pixels, 6px chips, 8px controls, 12–16px panels and cards.
- **Do** answer filled-button hover with the up-left 2px shift over the solid 4px magenta offset.
- **Do** put small magenta text in action (light) or pink ink (dark), never in signal magenta.
- **Do** build controls from the shadcn components in `src/components/ui/` and restyle them there; style navigation as buttons with `buttonVariants` on a real `<a>`.
- **Do** set every headline in Gotchu Display 700 uppercase and every reading line and control label in Gotchu Text.
- **Do** carry qualifying facts as numbered margin notes beside the paragraph they qualify.
- **Do** mark every primary path into the product with `data-catch`.
- **Do** give every moving piece a still state, a reduced-motion final state and a visible pause where it loops in the first viewport.
- **Do** make art from square-pixel dot fields authored in components.

### Don't:
- **Don't** use a graphite ground; graphite is ink and the light-theme footer only.
- **Don't** fill sections with magenta or run gradients between colour fields.
- **Don't** use pills, circles or any radius above 16px.
- **Don't** blur a shadow, add ambient elevation, or make the header or menu translucent or blurred.
- **Don't** use solid 3D objects, photos, metal, glass or any realistic render.
- **Don't** add captions or helper copy that explain the artwork or the page.
- **Don't** invent results, metrics, findings, customers or animated pseudo-data.
- **Don't** set small text on signal magenta (#e7147d).
- **Don't** ship or embed AIRNT; Saira is the licensed face.
- **Don't** put a tag or mono line above a headline as a kicker, or bring back the index rail or section numerals.
- **Don't** use custom cursors, scroll snapping or hijacking, a loader, or particles that cover content.
