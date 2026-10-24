from pathlib import Path
from math import cos, sin, pi

out = Path(__file__).resolve().parents[1] / 'apps/web/public/landing'
out.mkdir(parents=True, exist_ok=True)
blades = []
for i in range(8):
    angle = i * pi / 4
    points = []
    for radius, offset in [(145, 0), (145, .79), (74, 1.12), (67, .32)]:
        points.append(f'{260 + radius*cos(angle+offset):.2f},{260 + radius*sin(angle+offset):.2f}')
    blades.append(f'<polygon points="{" ".join(points)}" fill="url(#blade)" stroke="#f2dbe7" stroke-opacity=".24" stroke-width="1"/>')
marks=[]
for i in range(64):
    a=i*pi/32
    r=199 if i%8==0 else 204
    marks.append(f'<path d="M{260+r*cos(a):.2f} {260+r*sin(a):.2f}L{260+211*cos(a):.2f} {260+211*sin(a):.2f}"/>')
svg=f'''<svg xmlns="http://www.w3.org/2000/svg" width="520" height="540" viewBox="0 0 520 540">
<defs>
<linearGradient id="edge" x1="0" y1="0" x2=".9" y2="1"><stop stop-color="#73717c"/><stop offset=".3" stop-color="#25252e"/><stop offset=".64" stop-color="#09090f"/><stop offset="1" stop-color="#86808b"/></linearGradient>
<linearGradient id="metal" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#f1e9ed"/><stop offset=".15" stop-color="#6c6875"/><stop offset=".35" stop-color="#272733"/><stop offset=".62" stop-color="#4b4654"/><stop offset=".82" stop-color="#c3b5c2"/><stop offset="1" stop-color="#56515f"/></linearGradient>
<linearGradient id="blade" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#cbb9c9"/><stop offset=".3" stop-color="#514356"/><stop offset="1" stop-color="#16131f"/></linearGradient>
<radialGradient id="glass" cx=".35" cy=".25"><stop stop-color="#5b224c"/><stop offset=".5" stop-color="#1f1728"/><stop offset="1" stop-color="#09090e"/></radialGradient>
<linearGradient id="rim"><stop stop-color="#ff9dc9"/><stop offset=".4" stop-color="#e7147d"/><stop offset="1" stop-color="#720c44"/></linearGradient>
<linearGradient id="reflection" x1=".05" y1=".1" x2=".9" y2=".8"><stop stop-color="#fffefa" stop-opacity=".48"/><stop offset=".38" stop-color="#e99ac3" stop-opacity=".1"/><stop offset="1" stop-color="#e99ac3" stop-opacity="0"/></linearGradient>
<clipPath id="glassClip"><circle cx="260" cy="260" r="157"/></clipPath>
</defs>
<circle cx="260" cy="280" r="230" fill="#0a090f"/>
<circle cx="260" cy="274" r="230" fill="url(#edge)"/>
<circle cx="260" cy="260" r="230" fill="url(#metal)"/>
<circle cx="260" cy="260" r="225" fill="none" stroke="#d3c9d0" stroke-opacity=".45"/>
<circle cx="260" cy="260" r="218" fill="#17141e"/>
<circle cx="260" cy="260" r="211" fill="none" stroke="#72707a" stroke-width=".7"/>
<g stroke="#b8aebb" stroke-opacity=".7" stroke-width="1.4">{''.join(marks)}</g>
<circle cx="260" cy="260" r="186" fill="url(#metal)"/>
<circle cx="260" cy="260" r="177" fill="url(#rim)"/>
<circle cx="260" cy="260" r="167" fill="#120e18"/>
<circle cx="260" cy="260" r="158" fill="url(#glass)"/>
<g clip-path="url(#glassClip)">
<path d="M121 220c36-74 106-118 190-118 39 0 74 10 106 29" fill="none" stroke="url(#reflection)" stroke-width="12" stroke-linecap="round"/>
<path d="M158 151c37-30 84-45 133-42" fill="none" stroke="#fffefa" stroke-opacity=".14" stroke-width="2" stroke-linecap="round"/>
</g>
{''.join(blades)}
<circle cx="260" cy="260" r="158" fill="none" stroke="#fffefa" stroke-opacity=".12"/>
<circle cx="260" cy="260" r="65" fill="url(#glass)" stroke="#b01d70" stroke-width="1.5"/>
<path d="m246 240-20 20 20 20m28-40 20 20-20 20m-12-46-7 52" fill="none" stroke="#ffafd2" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M104 190a180 180 0 0 1 194-108" fill="none" stroke="#fffefa" stroke-opacity=".35" stroke-width="2"/>
</svg>'''
(out/'evidence-lens.svg').write_text(svg)
(out/'source-snapshot.svg').write_text('''<svg xmlns="http://www.w3.org/2000/svg" width="360" height="280" viewBox="0 0 360 280"><defs><linearGradient id="card" x2="1" y2="1"><stop stop-color="#393640"/><stop offset="1" stop-color="#191820"/></linearGradient></defs><rect x="3" y="8" width="350" height="265" rx="16" fill="#0b0a10"/><rect x="3" y="3" width="350" height="265" rx="16" fill="url(#card)" stroke="#79717e"/><path d="M4 47h348" stroke="#655b6a"/><g fill="#7f7382"><circle cx="25" cy="25" r="3"/><circle cx="38" cy="25" r="3"/><circle cx="51" cy="25" r="3"/></g><path d="m57 91-16 16 16 16m28-32 16 16-16 16m-11-38-8 44" stroke="#ff8fbe" fill="none" stroke-width="3" stroke-linecap="round"/><g stroke-width="5" stroke-linecap="round"><path d="M45 158h44m18 0h75m-117 23h60m16 0h103m-180 23h87m15 0h44m-124 23h50" stroke="#867b8c"/><path d="M205 158h61M210 204h45" stroke="#db438f"/><path d="M279 158h29M260 181h45M130 227h107" stroke="#514b5a"/></g></svg>''')
(out/'https-origin.svg').write_text('''<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300"><defs><linearGradient id="card" x2="1" y2="1"><stop stop-color="#35303c"/><stop offset="1" stop-color="#18151f"/></linearGradient><linearGradient id="globe" x2="1" y2="1"><stop stop-color="#f6ddeb"/><stop offset="1" stop-color="#af2c71"/></linearGradient></defs><rect x="5" y="10" width="286" height="284" rx="20" fill="#0c0a11"/><rect x="5" y="4" width="286" height="284" rx="20" fill="url(#card)" stroke="#736375"/><g fill="none" stroke="url(#globe)" stroke-width="1.7"><circle cx="148" cy="132" r="76"/><ellipse cx="148" cy="132" rx="34" ry="76"/><ellipse cx="148" cy="132" rx="76" ry="27"/><path d="M72 132h152M148 56v152"/></g><path d="M54 242h187" stroke="#66566d"/><path d="m128 236 5 5 10-12" fill="none" stroke="#ff8fbe" stroke-width="2"/><circle cx="211" cy="173" r="17" fill="#e7147d"/><path d="m204 173 5 5 9-11" fill="none" stroke="#fffefa" stroke-width="2"/></svg>''')
print('Authored assets:', ', '.join(p.name for p in out.glob('*.svg')))
