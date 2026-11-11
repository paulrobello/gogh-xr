"""Draws the sky river field images from scripts/sky-river/field.ts's JSON.

    python3 scripts/sky-river/draw.py build/sky-river/field.json docs/shots

sky-river-field.png: the river velocity (red, signed, length by speed; a dot where a stroke holds
still) over the scan, Paul's guide paths (green, with their arrowheads) and the kept wheels' rims
(white), with wheel members' arrows in white. Same layout as the before overlay
(docs/shots/sky-field-before.png): the 1024 x 811 frame.webp at 2x, cropped to its top 62%.

sky-river-field-around.png: the same over the whole dome above the horizon, azimuth -180..180
(0 straight ahead, the painter's view in the middle) and elevation -6..86, with the canvas frame
outlined in yellow.
"""
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

data = json.load(open(sys.argv[1]))
outdir = Path(sys.argv[2])
root = Path(__file__).resolve().parents[2]
RED = (255, 40, 40)
GREEN = (40, 255, 80)
WHITE = (255, 255, 255)


def arrow(dr, x0, y0, ux, uy, length, col, width=3, head=8):
    xe, ye = x0 + ux * length, y0 + uy * length
    dr.line([(x0, y0), (xe, ye)], fill=col, width=width)
    for a in (2.6, -2.6):
        dr.line(
            [(xe, ye), (xe + head * (ux * math.cos(a) - uy * math.sin(a)),
                        ye + head * (ux * math.sin(a) + uy * math.cos(a)))],
            fill=col, width=width)


def path_line(dr, pts, col, width=9, head=30):
    dr.line(pts, fill=col, width=width)
    (x0, y0), (x1, y1) = pts[-2], pts[-1]
    L = math.hypot(x1 - x0, y1 - y0) or 1
    ux, uy = (x1 - x0) / L, (y1 - y0) / L
    for a in (2.5, -2.5):
        dr.line([(x1, y1), (x1 + head * (ux * math.cos(a) - uy * math.sin(a)),
                            y1 + head * (ux * math.sin(a) + uy * math.cos(a)))],
                fill=col, width=width)


def draw_arrows(dr, items, to_px, scale):
    full = data['speed']
    for x0, y0, dx, dy, s, member in items:
        px0, py0 = to_px(x0, y0)
        px1, py1 = to_px(x0 + dx, y0 + dy)
        col = WHITE if member else RED
        if s < 0.04 * full:
            dr.ellipse([px0 - 3, py0 - 3, px0 + 3, py0 + 3], fill=col)
            continue
        L = math.hypot(px1 - px0, py1 - py0) or 1
        arrow(dr, px0, py0, (px1 - px0) / L, (py1 - py0) / L, scale(s / full), col)


# The canvas view.
im = Image.open(root / 'public/paintings/starry-night/frame.webp').convert('RGB')
W, H = im.size
ix, iy = 12 / 1024, 4 / 811


def p2(u, v):
    return (2 * (ix + u * (1 - 2 * ix)) * W, 2 * (iy + (1 - v) * (1 - 2 * iy)) * H)


im = im.resize((W * 2, H * 2))
W2, H2 = im.size
dr = ImageDraw.Draw(im)
for path in data['paths']:
    path_line(dr, [p2(u, v) for u, v in path['uv']], GREEN)
draw_arrows(dr, data['arrows'], p2, lambda k: 8 + 28 * min(k, 1.5))
for w in data['wheels']:
    pts = [p2(u, v) for u, v in w['rim']]
    if len(pts) > 2:
        dr.line(pts + [pts[0]], fill=WHITE, width=3)
im.crop((0, 0, W2, int(H2 * 0.62))).save(outdir / 'sky-river-field.png', optimize=True)

# The dome.
AW, AH = 2160, 600
AZ0, EL0, EL1 = -180, -8, 88


def pa(az, el):
    return ((az - AZ0) / 360 * AW, (EL1 - el) / (EL1 - EL0) * AH)


dome = Image.new('RGB', (AW, AH), (14, 22, 54))
dr = ImageDraw.Draw(dome)
for k in range(-180, 181, 30):
    dr.line([pa(k, EL0), pa(k, EL1)], fill=(40, 52, 90), width=1)
for k in range(0, 90, 15):
    dr.line([pa(-180, k), pa(180, k)], fill=(40, 52, 90), width=1)
fr = [pa(a, e) for a, e in data['frame']]
dr.line(fr + [fr[0]], fill=(255, 210, 60), width=3)
for path in data['paths']:
    path_line(dr, [pa(a, e) for a, e in path['azel']], GREEN, width=5, head=14)
for w in data['wheels']:
    pts = [pa(a, e) for a, e in w['rimAzel']]
    dr.line(pts + [pts[0]], fill=WHITE, width=2)


def pa_vec(az, el):
    return pa(az, el)


draw_arrows(dr, data['around'], pa_vec, lambda k: 4 + 16 * min(k, 1.5))
dome.save(outdir / 'sky-river-field-around.png', optimize=True)
print('wrote', outdir / 'sky-river-field.png', outdir / 'sky-river-field-around.png')
