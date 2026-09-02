# 사주 페이지의 링크 미리보기 이미지(og-saju.png)를 만든다.
# 카카오톡·슬랙에 주소를 붙여넣었을 때 보이는 카드다.
#   python tools/make-og-saju.py
import os
from PIL import Image, ImageDraw, ImageFont, ImageOps

W, H = 1200, 630
BG      = (14, 15, 19)
PANEL   = (22, 24, 31)
PANEL2  = (28, 31, 40)
BORDER  = (42, 45, 56)
TEXT    = (242, 243, 245)
DIM     = (146, 152, 168)
MUTE    = (107, 113, 128)
ACCENT  = (124, 92, 255)
ACCENT2 = (45, 212, 191)

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
    raise SystemExit("한글 폰트를 찾지 못했습니다. _CANDIDATES 에 경로를 추가해 주세요.")

def font(kind, size):
    return ImageFont.truetype(BOLD_PATH if kind == "bold" else REG_PATH, size)

img = Image.new("RGB", (W, H), BG)

# 사이트 상단과 같은 보랏빛 번짐
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

def grad_rect(box, c1, c2, radius=10):
    x0, y0, x1, y1 = [int(v) for v in box]
    w, h = max(1, x1 - x0), max(1, y1 - y0)
    strip = Image.new("RGB", (w, 1))
    for x in range(w):
        t = x / max(1, w - 1)
        strip.putpixel((x, 0), tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3)))
    g = strip.resize((w, h))
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=255)
    img.paste(g, (x0, y0), m)

# ── 왼쪽: 제목 ──
LX = 76
d.rounded_rectangle([LX, 92, LX + 52, 144], radius=14, fill=PANEL2, outline=BORDER, width=2)
grad_rect([LX, 92, LX + 52, 144], ACCENT, ACCENT2, radius=14)
d.text((LX + 13, 100), "命", font=font("bold", 30), fill=(255, 255, 255))
d.text((LX + 68, 104), "사주·이름 풀이", font=font("bold", 27), fill=TEXT)

d.text((LX, 190), "사주와 ", font=font("bold", 54), fill=TEXT)
w1 = d.textlength("사주와 ", font=font("bold", 54))
d.text((LX + w1, 190), "이름", font=font("bold", 54), fill=ACCENT2)
w2 = d.textlength("이름", font=font("bold", 54))
d.text((LX + w1 + w2, 190), "을", font=font("bold", 54), fill=TEXT)
d.text((LX, 258), "함께 읽습니다", font=font("bold", 54), fill=TEXT)

for i, line in enumerate([
        "절기와 진태양시를 반영한 만세력 계산.",
        "오행·대운·좋은 시기·이름 풀이·궁합까지",
        "한자리에서 봅니다."]):
    d.text((LX, 344 + i * 33), line, font=font("reg", 20), fill=DIM)

grad_rect([LX, 464, LX + 260, 471], ACCENT, ACCENT2, radius=4)

for i, chip in enumerate(["만세력", "오행·대운", "궁합", "이름"]):
    tw = d.textlength(chip, font=font("reg", 17)) + 26
    x = LX + sum(d.textlength(c, font=font("reg", 17)) + 26 + 10 for c in ["만세력", "오행·대운", "궁합", "이름"][:i])
    d.rounded_rectangle([x, 506, x + tw, 546], radius=20, fill=PANEL2, outline=BORDER, width=2)
    d.text((x + 13, 515), chip, font=font("reg", 17), fill=DIM)

# ── 오른쪽: 사주팔자 판 ──
PX0, PY0, PX1, PY1 = 604, 92, 1124, 538
d.rounded_rectangle([PX0, PY0, PX1, PY1], radius=20, fill=PANEL, outline=BORDER, width=2)
IX0, IX1 = PX0 + 26, PX1 - 26

d.text((IX0, PY0 + 24), "사주팔자", font=font("bold", 20), fill=TEXT)
d.text((IX0 + 96, PY0 + 28), "경오 신사 경진 계미", font=font("reg", 15), fill=MUTE)

# 네 기둥
pillars = [("시주", "癸", "계", "未", "미"), ("일주", "庚", "경", "辰", "진"),
           ("월주", "辛", "신", "巳", "사"), ("년주", "庚", "경", "午", "오")]
gap = 12
cw = (IX1 - IX0 - gap * 3) / 4
cy0, ch = PY0 + 62, 198
for i, (pos_, s_h, s_k, b_h, b_k) in enumerate(pillars):
    cx = IX0 + i * (cw + gap)
    is_day = (i == 1)
    d.rounded_rectangle([cx, cy0, cx + cw, cy0 + ch], radius=13,
                        fill=PANEL2, outline=ACCENT if is_day else BORDER, width=2)
    d.text((cx + cw / 2 - d.textlength(pos_, font=font("reg", 14)) / 2, cy0 + 12),
           pos_, font=font("reg", 14), fill=ACCENT2 if is_day else DIM)
    for j, (ch_, kr) in enumerate([(s_h, s_k), (b_h, b_k)]):
        gy = cy0 + 36 + j * 82
        f = font("bold", 44)
        d.text((cx + cw / 2 - d.textlength(ch_, font=f) / 2, gy), ch_, font=f, fill=TEXT)
        fk = font("reg", 14)
        d.text((cx + cw / 2 - d.textlength(kr, font=fk) / 2, gy + 56), kr, font=fk, fill=MUTE)
    d.line([cx + 12, cy0 + 116, cx + cw - 12, cy0 + 116], fill=BORDER, width=1)

# 오행 막대
by0 = cy0 + ch + 26
d.text((IX0, by0), "오행의 균형", font=font("bold", 17), fill=TEXT)
vals = [("목", 0.16), ("화", 0.62), ("토", 0.70), ("금", 1.0), ("수", 0.45)]
bw = IX1 - IX0 - 74
for i, (name, v) in enumerate(vals):
    y = by0 + 30 + i * 21
    d.text((IX0, y - 2), name, font=font("reg", 14), fill=DIM)
    d.rounded_rectangle([IX0 + 26, y, IX0 + 26 + bw, y + 12], radius=6, fill=PANEL2)
    col = ACCENT2 if name == "수" else ACCENT
    d.rounded_rectangle([IX0 + 26, y, IX0 + 26 + max(8, bw * v), y + 12], radius=6, fill=col)

img.save("og-saju.png", "PNG", optimize=True)
print("wrote og-saju.png", img.size)
