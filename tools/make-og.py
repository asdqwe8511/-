# Generates og-image.png (link preview card) and favicon.png.
# Re-run after branding changes:  python tools/make-og.py
from PIL import Image, ImageDraw, ImageFont, ImageOps

W, H = 1200, 630
BG       = (14, 15, 19)
PANEL    = (22, 24, 31)
PANEL2   = (28, 31, 40)
BORDER   = (42, 45, 56)
TEXT     = (242, 243, 245)
DIM      = (146, 152, 168)
ACCENT   = (124, 92, 255)
ACCENT2  = (45, 212, 191)
DANGER   = (255, 84, 112)

# 한글 폰트 찾기. 윈도우에서 만든 스크립트지만 리눅스/맥에서도 돌아가야 한다.
import os
_CANDIDATES = [
    ("C:/Windows/Fonts/malgunbd.ttf", "C:/Windows/Fonts/malgun.ttf"),
    ("/System/Library/Fonts/AppleSDGothicNeo.ttc", "/System/Library/Fonts/AppleSDGothicNeo.ttc"),
    ("/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf", "/usr/share/fonts/truetype/nanum/NanumGothic.ttf"),
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
    ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"),
]
for _b, _r in _CANDIDATES:
    if os.path.exists(_b) and os.path.exists(_r):
        BOLD_PATH, REG_PATH = _b, _r
        break
else:
    raise SystemExit("한글 폰트를 찾지 못했습니다. tools/make-og.py 의 _CANDIDATES 에 경로를 추가해 주세요.")

bold, reg = "bold", "reg"
def font(n, s):
    return ImageFont.truetype(BOLD_PATH if n == "bold" else REG_PATH, s)

img = Image.new("RGB", (W, H), BG)

# Hero glow, mirroring the site's radial gradient.
gw, gh = 1600, 1150
glow = ImageOps.invert(Image.radial_gradient("L")).resize((gw, gh))
tint = Image.new("RGB", (gw, gh), ACCENT)
layer = Image.new("RGB", (W, H), BG)
pos = ((W - gw) // 2, -gh // 2 - 30)
layer.paste(tint, pos)
mask = Image.new("L", (W, H), 0)
mask.paste(glow, pos)
img = Image.composite(layer, img, mask.point(lambda v: int(v * 0.26)))

d = ImageDraw.Draw(img)

def fit(text, name, size, max_w):
    """Shrink the font until the text fits max_w."""
    f = font(name, size)
    while d.textlength(text, font=f) > max_w and size > 10:
        size -= 2
        f = font(name, size)
    return f

def grad_rect(box, c1, c2, radius=10, vertical=False):
    """Rounded rect filled with a linear gradient."""
    x0, y0, x1, y1 = [int(v) for v in box]
    w, h = x1 - x0, y1 - y0
    if w <= 0 or h <= 0: return
    g = Image.new("RGB", (w, h))
    gd = ImageDraw.Draw(g)
    n = h if vertical else w
    for i in range(n):
        t = i / max(n - 1, 1)
        c = tuple(round(c1[k] + (c2[k] - c1[k]) * t) for k in range(3))
        if vertical: gd.line([(0, i), (w, i)], fill=c)
        else:        gd.line([(i, 0), (i, h)], fill=c)
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=255)
    img.paste(g, (x0, y0), m)

# ---------------- left column: brand + headline ----------------
LX, LW = 78, 430

d.rounded_rectangle([LX, 84, LX + 44, 128], radius=13, fill=ACCENT)
d.polygon([(LX + 17, 96), (LX + 17, 116), (LX + 33, 106)], fill=(255, 255, 255))
d.text((LX + 58, 92), "인기영상 대시보드", font=font(bold, 27), fill=TEXT)

f_h1 = fit("유튜브 인기 영상", bold, 62, LW)
d.text((LX, 196), "지금 뜨는", font=f_h1, fill=TEXT)
d.text((LX, 196 + f_h1.size + 16), "유튜브 인기 영상", font=f_h1, fill=ACCENT2)

f_sub = font(reg, 23)
d.text((LX, 366), "국가별 실시간 랭킹 · 채널 파인더", font=f_sub, fill=DIM)

# country pills
f_pc, f_pl = font(bold, 17), font(reg, 18)
x, y, ph = LX, 420, 44
for code, label in [("KR", "한국"), ("US", "미국"), ("JP", "일본"), ("IN", "인도")]:
    w = 20 + d.textlength(code, font=f_pc) + 8 + d.textlength(label, font=f_pl) + 20
    d.rounded_rectangle([x, y, x + w, y + ph], radius=22, fill=PANEL2, outline=BORDER, width=2)
    cx = x + 20
    d.text((cx, y + 14), code, font=f_pc, fill=ACCENT2)
    cx += d.textlength(code, font=f_pc) + 8
    d.text((cx, y + 11), label, font=f_pl, fill=TEXT)
    x += w + 10

# accent underline
grad_rect([LX, 512, LX + 300, 519], ACCENT, ACCENT2, radius=4)

# ---------------- right column: dashboard mockup ----------------
PX0, PY0, PX1, PY1 = 556, 80, 1124, 550
d.rounded_rectangle([PX0, PY0, PX1, PY1], radius=20, fill=PANEL, outline=BORDER, width=2)

IX0, IX1 = PX0 + 24, PX1 - 24
INNER_W = IX1 - IX0

# stat tiles
stats = [("전체 영상", "488개", TEXT), ("숏폼", "272개", DANGER), ("최고 조회수", "936만", ACCENT)]
tw = (INNER_W - 2 * 14) / 3
for i, (label, value, col) in enumerate(stats):
    tx = IX0 + i * (tw + 14)
    d.rounded_rectangle([tx, PY0 + 24, tx + tw, PY0 + 24 + 82], radius=13,
                        fill=PANEL2, outline=BORDER, width=2)
    d.text((tx + 16, PY0 + 37), label, font=font(reg, 16), fill=DIM)
    d.text((tx + 16, PY0 + 60), value, font=font(bold, 30), fill=col)

# section label
d.text((IX0, PY0 + 124), "국가별 실시간 랭킹", font=font(bold, 19), fill=TEXT)
d.rounded_rectangle([IX0 + 168, PY0 + 126, IX0 + 168 + 54, PY0 + 126 + 24],
                    radius=8, fill=PANEL2, outline=BORDER, width=2)
d.text((IX0 + 179, PY0 + 129), "488개", font=font(reg, 14), fill=ACCENT2)

# video card grid — synthetic duotone "thumbnails"
duos = [((124, 92, 255), (45, 212, 191)), ((255, 84, 112), (245, 165, 36)),
        ((59, 130, 246), (124, 92, 255)), ((34, 197, 94), (45, 212, 191)),
        ((236, 72, 153), (124, 92, 255)), ((245, 165, 36), (255, 84, 112))]
cols, rows, gap = 3, 2, 14
cw = (INNER_W - gap * (cols - 1)) / cols
th = cw * 9 / 16
ch = th + 40
gy0 = PY0 + 156

for i in range(cols * rows):
    r, c = divmod(i, cols)
    cx = IX0 + c * (cw + gap)
    cy = gy0 + r * (ch + gap)
    d.rounded_rectangle([cx, cy, cx + cw, cy + ch], radius=11, fill=PANEL2,
                        outline=BORDER, width=1)
    grad_rect([cx + 1, cy + 1, cx + cw - 1, cy + th], *duos[i], radius=10)

    # play glyph on the thumbnail
    px, py, s = cx + cw / 2, cy + th / 2, 11
    d.polygon([(px - s * .6, py - s), (px - s * .6, py + s), (px + s, py)],
              fill=(255, 255, 255, 230))
    # rank badge
    d.rounded_rectangle([cx + 7, cy + 7, cx + 29, cy + 27], radius=6, fill=(0, 0, 0))
    d.text((cx + 14, cy + 9), str(i + 1), font=font(bold, 14), fill=(255, 255, 255))
    # duration badge
    dur = "0:45" if i % 2 else "8:02"
    dw = d.textlength(dur, font=font(reg, 13)) + 12
    d.rounded_rectangle([cx + cw - 9 - dw, cy + th - 26, cx + cw - 9, cy + th - 8],
                        radius=5, fill=(0, 0, 0))
    d.text((cx + cw - 3 - dw, cy + th - 25), dur, font=font(reg, 13), fill=(255, 255, 255))
    # title / meta placeholder bars
    d.rounded_rectangle([cx + 10, cy + th + 11, cx + cw - 22, cy + th + 20], radius=4, fill=(58, 62, 76))
    d.rounded_rectangle([cx + 10, cy + th + 26, cx + cw - 58, cy + th + 33], radius=3, fill=(43, 46, 58))

img.save("og-image.png", "PNG", optimize=True)
print("wrote og-image.png", img.size)

# ---------------- favicon ----------------
S = 128
fav = Image.new("RGB", (S, S), BG)
fd = ImageDraw.Draw(fav)
fd.rounded_rectangle([8, 8, S - 8, S - 8], radius=28, fill=ACCENT)
fd.polygon([(48, 36), (48, 92), (94, 64)], fill=(255, 255, 255))
fav.save("favicon.png", "PNG", optimize=True)
print("wrote favicon.png", fav.size)
