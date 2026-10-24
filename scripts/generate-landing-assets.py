"""Authors the static landing artwork. Animated geometry (iris, globe) lives in apps/web/src/components."""
from pathlib import Path

out = Path(__file__).resolve().parents[1] / 'apps/web/public/landing'
out.mkdir(parents=True, exist_ok=True)
for stale in ('evidence-lens.svg', 'source-snapshot.svg', 'https-origin.svg'):
    (out / stale).unlink(missing_ok=True)

# Front face of the source-snapshot slab: a file sheet with a folder tab, code rows and a digest strip.
rows = [
    [(0, 46, '#8d8296'), (58, 70, '#d63c88'), (138, 34, '#5d5666')],
    [(22, 88, '#8d8296'), (120, 52, '#5d5666')],
    [(22, 40, '#5d5666'), (72, 96, '#ff8fbe'), (178, 30, '#8d8296')],
    [(44, 64, '#8d8296'), (118, 74, '#5d5666')],
    [(44, 120, '#5d5666'), (174, 42, '#d63c88')],
    [(22, 58, '#8d8296'), (90, 28, '#5d5666')],
    [(0, 30, '#8d8296')],
]
code = []
for index, row in enumerate(rows):
    y = 92 + index * 22
    code.append(f'<path d="M50 {y}h10" stroke="#4a4552" stroke-width="3" stroke-linecap="round"/>')
    for start, length, colour in row:
        x = 82 + start
        code.append(f'<path d="M{x} {y}h{length}" stroke="{colour}" stroke-width="6" stroke-linecap="round"/>')
fingerprint = ''.join(
    f'<path d="M{58 - r} 252a{r} {r} 0 0 1 {2 * r} 0" fill="none" stroke="#ff8fbe" stroke-opacity="{0.95 - i * 0.18:.2f}" stroke-width="2" stroke-linecap="round"/>'
    for i, r in enumerate((4, 8, 12, 16))
)
(out / 'code-slab.svg').write_text(f'''<svg xmlns="http://www.w3.org/2000/svg" width="400" height="290" viewBox="0 0 400 290">
<defs>
<linearGradient id="face" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#3d3946"/><stop offset=".5" stop-color="#25232e"/><stop offset="1" stop-color="#1a1922"/></linearGradient>
<linearGradient id="sheen" x1="0" y1="0" x2=".55" y2="1"><stop stop-color="#fffefa" stop-opacity=".2"/><stop offset=".38" stop-color="#fffefa" stop-opacity="0"/></linearGradient>
<linearGradient id="lip" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#e7147d"/><stop offset="1" stop-color="#ff8fbe" stop-opacity=".2"/></linearGradient>
</defs>
<path id="sheet" d="M14 34a14 14 0 0 1 14-14h92a14 14 0 0 1 11.6 6.2L141 40h231a14 14 0 0 1 14 14v208a14 14 0 0 1-14 14H28a14 14 0 0 1-14-14Z" fill="url(#face)" stroke="#9a90a2" stroke-opacity=".55" stroke-width="1.5"/>
<path d="M36 32l-6 6 6 6m14-12 6 6-6 6m-4-15-4 18" fill="none" stroke="#ff8fbe" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M68 38h40" stroke="#6d6577" stroke-width="5" stroke-linecap="round"/>
<path d="M150 60h220" stroke="url(#lip)" stroke-width="2" stroke-linecap="round"/>
{''.join(code)}
<path d="M30 232h340" stroke="#4a4552"/>
{fingerprint}
<path d="M88 252h120m14 0h40" stroke="#6d6577" stroke-width="5" stroke-linecap="round"/>
<path d="M14 34a14 14 0 0 1 14-14h92a14 14 0 0 1 11.6 6.2L141 40h231a14 14 0 0 1 14 14v208a14 14 0 0 1-14 14H28a14 14 0 0 1-14-14Z" fill="url(#sheen)"/>
</svg>''')

# The report the lens returns: findings with severity and confidence marks, an evidence excerpt and coverage cells.
findings = []
for index, (filled, confidence) in enumerate(((True, 3), (False, 2), (False, 1))):
    y = 118 + index * 46
    pip = '#e7147d' if filled else 'none'
    findings.append(f'<path d="M44 {y - 8}l8 8-8 8-8-8Z" fill="{pip}" stroke="#ff8fbe" stroke-width="1.6"/>')
    findings.append(f'<path d="M68 {y - 4}h{150 - index * 26}" stroke="#d9d0d6" stroke-width="6" stroke-linecap="round"/>')
    findings.append(f'<path d="M68 {y + 9}h{96 + index * 14}" stroke="#6d6577" stroke-width="4" stroke-linecap="round"/>')
    for tick in range(3):
        opacity = '1' if tick < confidence else '.25'
        findings.append(f'<path d="M{290 + tick * 10} {y - 7}v14" stroke="#ff8fbe" stroke-opacity="{opacity}" stroke-width="3" stroke-linecap="round"/>')
    findings.append(f'<path d="M32 {y + 23}h296" stroke="#3d3a47"/>')
cells = []
for index in range(14):
    x = 36 + (index % 7) * 42
    y = 344 + (index // 7) * 26
    dashed = index in (5, 6, 12, 13)
    style = 'fill="none" stroke="#8d8296" stroke-dasharray="3 3"' if dashed else 'fill="#4a4552" stroke="#8d8296" stroke-opacity=".5"'
    cells.append(f'<rect x="{x}" y="{y}" width="34" height="18" rx="3" {style}/>')
(out / 'report-sheet.svg').write_text(f'''<svg xmlns="http://www.w3.org/2000/svg" width="360" height="430" viewBox="0 0 360 430">
<defs>
<linearGradient id="paper" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#34303d"/><stop offset=".6" stop-color="#211f29"/><stop offset="1" stop-color="#1a1921"/></linearGradient>
<linearGradient id="sheen" x1="0" y1="0" x2=".7" y2=".9"><stop stop-color="#fffefa" stop-opacity=".18"/><stop offset=".35" stop-color="#fffefa" stop-opacity="0"/></linearGradient>
<linearGradient id="excerpt" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#e7147d"/><stop offset="1" stop-color="#ff8fbe"/></linearGradient>
</defs>
<path d="M22 6h268l60 60v344a14 14 0 0 1-14 14H22a14 14 0 0 1-14-14V20A14 14 0 0 1 22 6Z" fill="url(#paper)" stroke="#9a90a2" stroke-opacity=".55" stroke-width="1.5"/>
<path d="M290 6v46a14 14 0 0 0 14 14h46" fill="#3f3a49" stroke="#9a90a2" stroke-opacity=".55" stroke-width="1.5"/>
<circle cx="48" cy="52" r="18" fill="#e7147d"/>
<path d="M42 44h8l4 4v12H42Zm8 0v5h4m-9 5h6" fill="none" stroke="#fffefa" stroke-width="1.6" stroke-linejoin="round"/>
<path d="M80 46h120" stroke="#fffefa" stroke-width="7" stroke-linecap="round"/>
<path d="M80 62h72" stroke="#8d8296" stroke-width="4" stroke-linecap="round"/>
<path d="M32 86h296" stroke="#4a4552"/>
{''.join(findings)}
<rect x="32" y="262" width="296" height="62" rx="8" fill="#121118" stroke="#3d3a47"/>
<path d="M48 282h64m10 0h90M48 304h40" stroke="#5d5666" stroke-width="5" stroke-linecap="round"/>
<path d="M98 304h132" stroke="url(#excerpt)" stroke-width="5" stroke-linecap="round"/>
{''.join(cells)}
<path d="M32 400h112" stroke="#6d6577" stroke-width="4" stroke-linecap="round"/>
<text x="328" y="405" text-anchor="end" fill="#ff8fbe" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="13" letter-spacing="1">{{ JSON }}</text>
<path d="M22 6h268l60 60v344a14 14 0 0 1-14 14H22a14 14 0 0 1-14-14V20A14 14 0 0 1 22 6Z" fill="url(#sheen)"/>
</svg>''')
print('Authored assets:', ', '.join(sorted(p.name for p in out.glob('*.svg'))))
