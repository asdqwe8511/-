# Generates og-image.png — the link preview card shown by KakaoTalk,
# Slack, Facebook, X, etc. Re-run this if the site's branding changes:
#   python tools/make-og.py
from PIL import Image, ImageDraw, ImageFont, ImageOps

W, H = 1200, 630
BG        = (14, 15, 19)
PANEL     = (28, 31, 40)
BORDER    = (42, 45, 56)
TEXT      = (242, 243, 245)
TEXT_DIM  = (146, 152, 168)
ACCENT    = (124, 92, 255)   # purple
ACCENT2   = (45, 212, 191)   # teal
DANGER    = (255, 84, 112)

F = "C:/Windows/Fonts/"
def font(name, size):
    return ImageFont.truetype(F + name, size)

bold, reg = "malgunbd.ttf", "malgun.ttf"

img = Image.new("RGB", (W, H), BG)

# Soft purple glow behind the headline, mirroring the site's hero gradient.
gw, gh = 1500, 1100
glow = ImageOps.invert(Image.radial_gradient("L")).resize((gw, gh))
tint = Image.new("RGB", (gw, gh), ACCENT)
layer = Image.new("RGB", (W, H), BG)
layer.paste(tint, ((W - gw) // 2, -gh // 2 - 40))
mask = Image.new("L", (W, H), 0)
mask.paste(glow, ((W - gw) // 2, -gh // 2 - 40))
img = Image.composite(layer, img, mask.point(lambda v: int(v * 0.30)))

d = ImageDraw.Draw(img)

def text_run(x, y, parts, f):
    """Draw differently-coloured segments on one baseline; returns total width."""
    for s, c in parts:
        d.text((x, y), s, font=f, fill=c)
        x += d.textlength(s, font=f)
    return x

def run_width(parts, f):
    return sum(d.textlength(s, font=f) for s, _ in parts)

# Brand row
f_brand = font(bold, 30)
bx = 90
d.rounded_rectangle([bx, 74, bx + 46, 120], radius=13, fill=ACCENT)
d.text((bx + 12, 82), "▶", font=font(bold, 24), fill=(255, 255, 255))
d.text((bx + 62, 80), "인기영상 대시보드", font=f_brand, fill=TEXT)

# Headline
f_h1 = font(bold, 78)
line = [("지금 뜨는 ", TEXT), ("유튜브 인기 영상", ACCENT2)]
text_run((W - run_width(line, f_h1)) / 2, 196, line, f_h1)

# Subhead
f_sub = font(reg, 30)
sub = "국가별 · 카테고리별 실시간 인기 영상을 한눈에"
d.text(((W - d.textlength(sub, font=f_sub)) / 2, 306), sub, font=f_sub, fill=TEXT_DIM)

# Country pills
f_pill_c = font(bold, 22)
f_pill_l = font(reg, 24)
pills = [("KR", "한국"), ("US", "미국"), ("JP", "일본"), ("IN", "인도")]
pad_x, gap, ph = 26, 18, 60
widths = [pad_x * 2 + d.textlength(c, font=f_pill_c) + 10 + d.textlength(l, font=f_pill_l)
          for c, l in pills]
x = (W - (sum(widths) + gap * (len(pills) - 1))) / 2
y = 392
for (code, label), w in zip(pills, widths):
    d.rounded_rectangle([x, y, x + w, y + ph], radius=30, fill=PANEL, outline=BORDER, width=2)
    cx = x + pad_x
    d.text((cx, y + 19), code, font=f_pill_c, fill=ACCENT2)
    cx += d.textlength(code, font=f_pill_c) + 10
    d.text((cx, y + 16), label, font=f_pill_l, fill=TEXT)
    x += w + gap

# Bottom accent bar, purple -> teal
bar_y, bar_h, bar_w = 520, 8, 420
bar_x = (W - bar_w) / 2
for i in range(bar_w):
    t = i / (bar_w - 1)
    col = tuple(round(ACCENT[k] + (ACCENT2[k] - ACCENT[k]) * t) for k in range(3))
    d.rectangle([bar_x + i, bar_y, bar_x + i + 1, bar_y + bar_h], fill=col)

# Footer note
f_foot = font(reg, 23)
foot = "실시간 인기영상 · 채널 파인더"
d.text(((W - d.textlength(foot, font=f_foot)) / 2, 556), foot, font=f_foot, fill=TEXT_DIM)

img.save("og-image.png", "PNG", optimize=True)
print("wrote og-image.png", img.size)

# --- favicon: small square mark reusing the same purple play badge ---
S = 128
fav = Image.new("RGB", (S, S), BG)
fd = ImageDraw.Draw(fav)
fd.rounded_rectangle([8, 8, S - 8, S - 8], radius=28, fill=ACCENT)
tri = [(48, 36), (48, 92), (94, 64)]
fd.polygon(tri, fill=(255, 255, 255))
fav.save("favicon.png", "PNG", optimize=True)
print("wrote favicon.png", fav.size)
