#!/usr/bin/env python3
# The Liner mark: a hollow ring with a white bead on the ring line at the top, lower right and lower left (an
# upward triangle). The ring is cut around each bead by a circle concentric with it, so every arc ends in a
# concave face that keeps a constant clear gap to the bead and follows its curvature. Writes public/favicon.svg
# and the #i-liner symbol in public/index.html; the PNG icons are rasterised from the SVG by Quick Look:
#   python3 tools/logo.py [gap]        (gap = clear space between an arc's end face and the bead, in 64-grid units)
#   qlmanage -t -s 256 -o /tmp/linerql public/favicon.svg && cp /tmp/linerql/favicon.svg.png public/favicon.png && sips -z 64 64 public/favicon.png
#   cp /tmp/linerql/favicon.svg.png public/apple-touch-icon.png && sips -z 180 180 public/apple-touch-icon.png
# The SVG root must not carry width/height, or Quick Look renders a 64 px icon in the corner of the 256 px canvas.
import math, os, sys
R, cx, cy, W = 23.0, 32.0, 32.0, 10.0          # ring radius, centre, stroke width
rd = 6.8                                        # bead radius
gap = float(sys.argv[1]) if len(sys.argv) > 1 else 5.5
dotAngles = [-90, 30, 150]
P = lambda a: (cx + R * math.cos(math.radians(a)), cy + R * math.sin(math.radians(a)))
dots = [P(a) for a in dotAngles]
cut = ''.join(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{rd + gap:.2f}" fill="#000"/>' for x, y in dots)
glow = ''.join(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{rd + 0.3:.1f}"/>' for x, y in dots)
beads = ''.join(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{rd}"/>' for x, y in dots)
ART = f"""<defs>
    <linearGradient id="lnTile" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5468c8"/><stop offset="0.55" stop-color="#6b3f8e"/><stop offset="1" stop-color="#8e3a60"/>
    </linearGradient>
    <linearGradient id="lnRim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.34"/><stop offset="0.5" stop-color="#ffffff" stop-opacity="0.04"/><stop offset="1" stop-color="#000000" stop-opacity="0.12"/>
    </linearGradient>
    <filter id="lnGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="0.9"/></filter>
    <mask id="lnCut" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"><rect width="64" height="64" fill="#fff"/>{cut}</mask>
  </defs>
  <g mask="url(#lnCut)">
    <circle cx="{cx:g}" cy="{cy:g}" r="{R:g}" fill="none" stroke="url(#lnTile)" stroke-width="{W:g}"/>
    <circle cx="{cx:g}" cy="{cy:g}" r="{R:g}" fill="none" stroke="url(#lnRim)" stroke-width="{W:g}"/>
  </g>
  <g fill="currentColor" fill-opacity="0.5" filter="url(#lnGlow)">{glow}</g>
  <g fill="#ffffff">{beads}</g>"""
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public')
open(os.path.join(root, 'favicon.svg'), 'w').write('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" color="#ffd1a3">\n  ' + ART + '\n</svg>\n')
p = os.path.join(root, 'index.html'); s = open(p).read()
a = s.index('  <symbol id="i-liner" viewBox="0 0 64 64">'); b = s.index('</symbol>', a) + len('</symbol>')
open(p, 'w').write(s[:a] + '  <symbol id="i-liner" viewBox="0 0 64 64">\n  ' + ART + '\n  </symbol>' + s[b:])
half = math.degrees(math.asin(W / 2 / (rd + gap)))
print(f'gap {gap:g} units = {gap * 26 / 64:.1f} px in the 26 px top-bar mark, {gap:.1f} px at 64 px, {gap * 180 / 64:.1f} px at 180 px; '
      f'arc faces start {math.degrees((rd + gap) / R):.1f}° from each bead centre (line {120 - 2 * math.degrees((rd + gap) / R):.1f}° long); '
      f'each face is an arc of radius {rd + gap:.1f} spanning ±{half:.1f}°, concave by {(rd + gap) * (1 - math.cos(math.radians(half))):.2f} units')
