# Original box art for the README screenshots' demo library (fictional games, no real
# artwork). Usage: python3 covers.py <outDir> demo-games.json
import json, math, random, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont
out = sys.argv[1]
games = json.load(open(sys.argv[2]))
FONT = '/usr/share/fonts/opentype/inter/InterDisplay-Black.otf'
try: ImageFont.truetype(FONT, 10)
except Exception: FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
def grad(w, h, c1, c2):
    img = Image.new('RGB', (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / h
        d.line([(0, y), (w, y)], fill=tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3)))
    return img
def hexc(s): return tuple(int(s[i:i+2], 16) for i in (1, 3, 5))
def art(w, h, g, seed, title=True):
    rnd = random.Random(seed)
    img = grad(w, h, hexc(g['c1']), hexc(g['c2']))
    layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    shape = g.get('shape', 'orbs')
    acc = hexc(g['accent'])
    if shape == 'orbs':
        for _ in range(9):
            r = rnd.randint(w // 14, w // 4); x, y = rnd.randint(0, w), rnd.randint(0, h)
            d.ellipse([x - r, y - r, x + r, y + r], fill=acc + (rnd.randint(40, 120),))
    elif shape == 'mountains':
        for k in range(4):
            base = int(h * (0.55 + k * 0.1)); pts = [(0, h)]
            for x in range(0, w + 60, 60): pts.append((x, base - rnd.randint(0, h // 5)))
            pts.append((w, h)); d.polygon(pts, fill=tuple(max(0, c - 40 * k) for c in acc) + (200,))
        d.ellipse([w * .62, h * .12, w * .62 + w * .2, h * .12 + w * .2], fill=(255, 240, 200, 210))
    elif shape == 'grid':
        for i in range(0, w, w // 10): d.line([(i, h * .55), (w / 2 + (i - w / 2) * 3, h)], fill=acc + (150,), width=3)
        for j in range(8): y = h * .55 + (h * .45) * (j / 8) ** 1.6; d.line([(0, y), (w, y)], fill=acc + (150,), width=3)
        d.ellipse([w * .25, h * .18, w * .75, h * .18 + w * .5], fill=(255, 120, 180, 200))
    elif shape == 'stars':
        for _ in range(140):
            x, y = rnd.randint(0, w), rnd.randint(0, h); s = rnd.choice([1, 1, 2, 3])
            d.ellipse([x, y, x + s, y + s], fill=(255, 255, 255, rnd.randint(120, 255)))
        d.ellipse([w * .15, h * .25, w * .85, h * .25 + w * .7], outline=acc + (230,), width=10)
        d.ellipse([w * .3, h * .35, w * .7, h * .35 + w * .4], fill=acc + (170,))
    elif shape == 'waves':
        for k in range(7):
            pts = [(x, h * (0.45 + k * .08) + math.sin(x / (w / 6) + k) * h * .03) for x in range(0, w + 10, 10)]
            d.line(pts, fill=acc + (220 - k * 20,), width=10)
    elif shape == 'blocks':
        for _ in range(26):
            s = rnd.randint(w // 14, w // 6); x, y = rnd.randint(0, w), rnd.randint(int(h * .35), h)
            d.rectangle([x, y, x + s, y + s], fill=acc + (rnd.randint(110, 230),), outline=(0, 0, 0, 90), width=3)
    img = Image.alpha_composite(img.convert('RGBA'), layer.filter(ImageFilter.GaussianBlur(1)))
    if title:
        d = ImageDraw.Draw(img)
        size = int(w * 0.13)
        font = ImageFont.truetype(FONT, size)
        longest = max(g['title'].upper().split(), key=lambda x: d.textlength(x, font=font))
        while d.textlength(longest, font=font) > w * .86 and size > 20:
            size -= 2
            font = ImageFont.truetype(FONT, size)
        words = g['title'].upper().split(); lines, cur = [], ''
        for wd in words:
            t = (cur + ' ' + wd).strip()
            if d.textlength(t, font=font) > w * .84 and cur: lines.append(cur); cur = wd
            else: cur = t
        lines.append(cur)
        y = int(h * .12)
        for ln in lines:
            tw = d.textlength(ln, font=font)
            d.text(((w - tw) / 2 + 3, y + 3), ln, font=font, fill=(0, 0, 0, 140))
            d.text(((w - tw) / 2, y), ln, font=font, fill=(255, 255, 255, 255))
            y += int(size * 1.08)
    return img.convert('RGB')
for i, g in enumerate(games):
    art(600, 840, g, i).save(f"{out}/{g['slug']}-cover.png")
    art(1280, 720, g, i + 100, title=False).save(f"{out}/{g['slug']}-bg.png")
print('ok', len(games))
