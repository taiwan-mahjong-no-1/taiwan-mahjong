"""台灣麻將美術素材產生器：輸出 SVG（文字已轉外框）與 PNG。

用法：
  python3 tools/gen_assets.py              # 預設風格（牌面、按鈕、骰子、牌桌、草圖）
  SKIN=yellow python3 tools/gen_assets.py  # 黃色風格（只產生牌與牌桌）
  SKIN=black  python3 tools/gen_assets.py  # 黑色風格
"""
import json, os, math, shutil, sys
from fontTools.ttLib import TTCollection
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
import cairosvg

SKIN = os.environ.get("SKIN", "classic")
OUT = os.path.join(os.path.dirname(__file__), "..", "build", "assets" if SKIN == "classic" else f"skins/{SKIN}")
shutil.rmtree(OUT, ignore_errors=True)
for d in ["tiles/svg", "tiles/png", "ui/svg", "ui/png", "table", "mockup"]:
    os.makedirs(f"{OUT}/{d}", exist_ok=True)

SERIF = TTCollection("/usr/share/fonts/opentype/noto/NotoSerifCJK-Black.ttc").fonts[3]
SANS = TTCollection("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc").fonts[3]

def glyph_path(font, ch):
    gs = font.getGlyphSet()
    name = font.getBestCmap()[ord(ch)]
    pen = SVGPathPen(gs); gs[name].draw(pen)
    bp = BoundsPen(gs); gs[name].draw(bp)
    return pen.getCommands(), bp.bounds, gs[name].width

def text_path(ch, cx, cy, size, fill, font=SERIF, box_center=True):
    """把單一字元轉成置中的 <path>。size = 字高（以 em 為準）。"""
    d, bounds, adv = glyph_path(font, ch)
    if bounds is None:
        return ""
    x0, y0, x1, y1 = bounds
    s = size / 1000.0
    gx = (x0 + x1) / 2 if box_center else adv / 2
    gy = (y0 + y1) / 2 if box_center else 380
    # 字型座標 y 向上，SVG 向下
    return (f'<path d="{d}" fill="{fill}" '
            f'transform="translate({cx - gx * s:.2f},{cy + gy * s:.2f}) scale({s:.4f},{-s:.4f})"/>')

def text_run(txt, cx, cy, size, fill, font=SANS, spacing=0.05):
    """多字元水平置中。"""
    advs = [glyph_path(font, c)[2] * size / 1000 for c in txt]
    total = sum(advs) + spacing * size * (len(txt) - 1)
    x = cx - total / 2
    parts = []
    for c, a in zip(txt, advs):
        parts.append(text_path(c, x + a / 2, cy, size, fill, font, box_center=False))
        x += a + spacing * size
    return "".join(parts)

# ---------- 顏色 ----------
PALETTES = {
    # 預設：象牙白牌面、綠色牌背
    "classic": dict(INK="#1d2a44", RED="#c62828", GREEN="#1f7a4d", BLUE="#1f4e9c",
                    FACE="#fbf6e9", FACE_EDGE="#e7dcc0", INNER="#efe6cf", BACK="#1f7a4d", BACK_DARK="#145638",
                    C_AUTUMN="#b5651d", C_ORCHID="#7b3fa0", C_CHRYS="#b8860b"),
    # 黃色：牌面一樣白底（好辨識），只有牌背改成黃色（包子寶寶）
    "yellow": dict(INK="#1d2a44", RED="#c62828", GREEN="#1f7a4d", BLUE="#1f4e9c",
                   FACE="#fbf6e9", FACE_EDGE="#e7dcc0", INNER="#efe6cf", BACK="#f7c62f", BACK_DARK="#d49a00",
                   C_AUTUMN="#b5651d", C_ORCHID="#7b3fa0", C_CHRYS="#b8860b"),
    # 薯片：牌面白底，牌背亮檸檬黃（原創角色「脆脆薯片妹」）
    "chips": dict(INK="#1d2a44", RED="#c62828", GREEN="#1f7a4d", BLUE="#1f4e9c",
                  FACE="#fbf6e9", FACE_EDGE="#e7dcc0", INNER="#efe6cf", BACK="#ffe83d", BACK_DARK="#e6c200",
                  C_AUTUMN="#b5651d", C_ORCHID="#7b3fa0", C_CHRYS="#b8860b"),
    # 黑色：牌面一樣白底，只有牌背改成黑色（貓頭鷹）
    "black": dict(INK="#1d2a44", RED="#c62828", GREEN="#1f7a4d", BLUE="#1f4e9c",
                  FACE="#fbf6e9", FACE_EDGE="#e7dcc0", INNER="#efe6cf", BACK="#22232a", BACK_DARK="#0e0e12",
                  C_AUTUMN="#b5651d", C_ORCHID="#7b3fa0", C_CHRYS="#b8860b"),
}
P = PALETTES[SKIN]
INK, RED, GREEN, BLUE = P["INK"], P["RED"], P["GREEN"], P["BLUE"]
FACE, FACE_EDGE, INNER, BACK, BACK_DARK = P["FACE"], P["FACE_EDGE"], P["INNER"], P["BACK"], P["BACK_DARK"]

W, H, DEPTH = 60, 78, 6   # 牌面 60x78，下方厚度 6
VB_H = H + DEPTH

def tile_shell(inner):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {VB_H}" width="{W*2}" height="{VB_H*2}">'
            f'<rect x="0.5" y="{DEPTH}" width="{W-1}" height="{H-0.5}" rx="6" fill="{BACK}"/>'
            f'<rect x="0.5" y="{DEPTH+H-8}" width="{W-1}" height="7.5" rx="4" fill="{BACK_DARK}"/>'
            f'<rect x="0.5" y="0.5" width="{W-1}" height="{H-1}" rx="6" fill="{FACE}" stroke="{FACE_EDGE}" stroke-width="1"/>'
            f'<rect x="3" y="3" width="{W-6}" height="{H-6}" rx="4" fill="none" stroke="{INNER}" stroke-width="0.8"/>'
            f'{inner}</svg>')

# ---------- 萬 ----------
NUMS = "一二三四五六七八九"
def man(n):
    return tile_shell(text_path(NUMS[n-1], 30, 24, 30, INK) + text_path("萬", 30, 56, 32, RED))

# ---------- 筒 ----------
def dot(cx, cy, r, color):
    return (f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{color}"/>'
            f'<circle cx="{cx}" cy="{cy}" r="{r*0.72:.2f}" fill="{FACE}"/>'
            f'<circle cx="{cx}" cy="{cy}" r="{r*0.5:.2f}" fill="{color}"/>'
            f'<circle cx="{cx}" cy="{cy}" r="{r*0.2:.2f}" fill="{FACE}"/>')

def pin(n):
    L, R, C = 18, 42, 30
    if n == 1:
        g = (f'<circle cx="30" cy="39" r="22" fill="{GREEN}"/>'
             f'<circle cx="30" cy="39" r="18" fill="{FACE}"/>'
             + "".join(f'<circle cx="{30+14*math.cos(a*math.pi/6):.2f}" cy="{39+14*math.sin(a*math.pi/6):.2f}" r="2.3" fill="{BLUE}"/>' for a in range(12))
             + f'<circle cx="30" cy="39" r="9.5" fill="{RED}"/><circle cx="30" cy="39" r="6" fill="{FACE}"/><circle cx="30" cy="39" r="3" fill="{RED}"/>')
        return tile_shell(g)
    spots = {
        2: [(C, 22, GREEN), (C, 56, BLUE)],
        3: [(16, 18, BLUE), (C, 39, RED), (44, 60, GREEN)],
        4: [(L, 22, BLUE), (R, 22, GREEN), (L, 56, GREEN), (R, 56, BLUE)],
        5: [(16, 18, BLUE), (44, 18, GREEN), (C, 39, RED), (16, 60, GREEN), (44, 60, BLUE)],
        6: [(L, 16, GREEN), (R, 16, GREEN), (L, 41, RED), (R, 41, RED), (L, 62, RED), (R, 62, RED)],
        7: [(14, 14, GREEN), (C, 22, GREEN), (46, 30, GREEN), (L, 47, RED), (R, 47, RED), (L, 64, RED), (R, 64, RED)],
        8: [(L, y, BLUE) for y in (13, 30, 47, 64)] + [(R, y, BLUE) for y in (13, 30, 47, 64)],
        9: [(x, y, col) for y, col in ((16, BLUE), (39, RED), (62, GREEN)) for x in (13, 30, 47)],
    }[n]
    r = {2: 11, 3: 10, 4: 10, 5: 9.5, 6: 8.5, 7: 7.5, 8: 7.5, 9: 7.5}[n]
    return tile_shell("".join(dot(x, y, r, c) for x, y, c in spots))

# ---------- 條 ----------
def stick(cx, cy, h, color, w=5.6):
    x, y = cx - w / 2, cy - h / 2
    return (f'<rect x="{x:.2f}" y="{y:.2f}" width="{w}" height="{h}" rx="{w/2}" fill="{color}"/>'
            f'<rect x="{x-0.6:.2f}" y="{cy-1.1:.2f}" width="{w+1.2:.2f}" height="2.2" rx="1" fill="{color}"/>'
            f'<line x1="{cx}" y1="{y+2.5:.2f}" x2="{cx}" y2="{cy-2.5:.2f}" stroke="{FACE}" stroke-width="1" stroke-linecap="round"/>'
            f'<line x1="{cx}" y1="{cy+2.5:.2f}" x2="{cx}" y2="{y+h-2.5:.2f}" stroke="{FACE}" stroke-width="1" stroke-linecap="round"/>')

def bird():
    """一條的鳥：孔雀般的長尾羽、綠身藍翅、紅冠，站在一截竹枝上。"""
    Y = "#e8a317"   # 喙、腳
    LIGHT = "#8fce6b"
    parts = []
    # 尾羽（身體後方往左下展開，末端有眼斑）
    for (x2, y2, c) in [(7, 66, GREEN), (13, 70, BLUE), (20, 71, GREEN)]:
        parts.append(f'<path d="M27 46 Q {(27+x2)/2-4:.1f} {(46+y2)/2:.1f} {x2} {y2}" stroke="{c}" stroke-width="3.2" fill="none" stroke-linecap="round"/>')
        parts.append(f'<circle cx="{x2}" cy="{y2}" r="3.4" fill="{c}"/><circle cx="{x2}" cy="{y2}" r="1.6" fill="{RED}"/>')
    # 竹枝
    parts.append(f'<rect x="16" y="58" width="36" height="5" rx="2.5" fill="{GREEN}"/>'
                 f'<rect x="33" y="57" width="2.2" height="7" rx="1" fill="{BLUE}"/>'
                 f'<path d="M48 58 C 52 52, 56 50, 58 49 C 56 54, 53 57, 48 58 Z" fill="{LIGHT}"/>')
    # 腳
    parts.append(f'<path d="M31 50 L 29 58 M 36 50 L 37 58" stroke="{Y}" stroke-width="1.8" stroke-linecap="round"/>')
    # 身體
    parts.append(f'<path d="M22 38 C 22 27, 34 22, 41 27 C 46 31, 44 45, 36 50 C 29 54, 22 48, 22 38 Z" fill="{GREEN}"/>')
    # 胸口
    parts.append(f'<path d="M38 29 C 44 33, 42 44, 35 48 C 38 42, 39 35, 38 29 Z" fill="{LIGHT}"/>')
    # 翅膀（藍，有紅色羽紋）
    parts.append(f'<path d="M24 35 C 27 29, 35 30, 36 37 C 36 43, 30 48, 23 47 C 25 43, 23 39, 24 35 Z" fill="{BLUE}"/>'
                 f'<path d="M27 38 Q 31 40 30 45 M 30 35 Q 34 38 33 43" stroke="{RED}" stroke-width="1" fill="none" stroke-linecap="round"/>')
    # 頭與頸
    parts.append(f'<path d="M36 28 C 36 22, 38 16, 43 15 C 48 14, 51 18, 50 22 C 49 26, 44 28, 41 31 Z" fill="{GREEN}"/>')
    # 喙
    parts.append(f'<path d="M49.5 19 L 56 21 L 49.5 23 Z" fill="{Y}"/>')
    # 眼
    parts.append('<circle cx="45" cy="19.5" r="2.4" fill="#fffdf5"/><circle cx="45.6" cy="19.5" r="1.3" fill="#1d2a44"/>')
    # 冠羽
    for (cx, cy) in [(40, 10), (43.5, 8.5), (47, 9.5)]:
        parts.append(f'<line x1="44" y1="15" x2="{cx}" y2="{cy+2}" stroke="{GREEN}" stroke-width="1"/>'
                     f'<circle cx="{cx}" cy="{cy}" r="1.9" fill="{RED}"/>')
    return "".join(parts)

def sou(n):
    if n == 1:  # 一條：傳統風格的鳥站在竹枝上（原創繪製）
        return tile_shell(bird())
    h2, h3 = 30, 20
    layouts = {
        2: [(30, 22, h2, GREEN), (30, 56, h2, BLUE)],
        3: [(30, 22, h2, GREEN), (19, 56, h2, BLUE), (41, 56, h2, BLUE)],
        4: [(19, 22, h2, GREEN), (41, 22, h2, BLUE), (19, 56, h2, BLUE), (41, 56, h2, GREEN)],
        5: [(14, 22, h2, GREEN), (46, 22, h2, BLUE), (30, 39, h2, RED), (14, 56, h2, BLUE), (46, 56, h2, GREEN)],
        6: [(x, y, h2, GREEN if y < 39 else BLUE) for y in (22, 56) for x in (15, 30, 45)],
        7: [(30, 15, h3, RED)] + [(x, y, h3, GREEN if y < 50 else BLUE) for y in (39, 63) for x in (15, 30, 45)],
        # 八條：上面一個 M、下面一個倒過來的 M（W）
        8: [(11, 22, 28, GREEN, 0), (23, 23, 28, GREEN, -22), (37, 23, 28, GREEN, 22), (49, 22, 28, GREEN, 0),
            (11, 56, 28, BLUE, 0), (23, 55, 28, BLUE, 22), (37, 55, 28, BLUE, -22), (49, 56, 28, BLUE, 0)],
        9: [(x, y, h3, RED if x == 30 else (GREEN if y < 39 else BLUE)) for y in (15, 39, 63) for x in (15, 30, 45)],
    }
    def draw(spec):
        x, y, h, c, *rest = spec
        a = rest[0] if rest else 0
        g = stick(x, y, h, c)
        return f'<g transform="rotate({a} {x} {y})">{g}</g>' if a else g
    return tile_shell("".join(draw(sp) for sp in layouts[n]))

# ---------- 字牌 ----------
def honor(ch, color):
    return tile_shell(text_path(ch, 30, 39, 44, color))

def haku():
    return tile_shell(f'<rect x="12" y="15" width="36" height="48" rx="3" fill="none" stroke="{BLUE}" stroke-width="3.2"/>'
                      f'<rect x="16.5" y="19.5" width="27" height="39" rx="1.5" fill="none" stroke="{BLUE}" stroke-width="1.2"/>')

# ---------- 花牌 ----------
def petals(cx, cy, r, color, k=5):
    return "".join(f'<ellipse cx="{cx+r*math.cos(2*math.pi*i/k - math.pi/2):.2f}" cy="{cy+r*math.sin(2*math.pi*i/k - math.pi/2):.2f}" rx="{r*0.62:.2f}" ry="{r*0.62:.2f}" fill="{color}" opacity="0.9"/>' for i in range(k)) + f'<circle cx="{cx}" cy="{cy}" r="{r*0.5:.2f}" fill="#f2b705"/>'

def flower(ch, num, color, motif):
    corner = text_path(str(num), 50, 12, 11, color, SANS)
    return tile_shell(motif + text_path(ch, 30, 50, 30, color) + corner)

FLOWERS = [
    ("春", 1, GREEN, petals(22, 20, 5, "#e57399")),
    ("夏", 2, RED, f'<circle cx="22" cy="20" r="7" fill="#f2b705"/>' + "".join(f'<line x1="{22+9*math.cos(a):.1f}" y1="{20+9*math.sin(a):.1f}" x2="{22+12*math.cos(a):.1f}" y2="{20+12*math.sin(a):.1f}" stroke="#f2b705" stroke-width="1.6" stroke-linecap="round"/>' for a in [i*math.pi/4 for i in range(8)])),
    ("秋", 3, P["C_AUTUMN"], f'<path d="M14 26 C 16 14, 28 10, 32 12 C 30 20, 24 28, 14 26 Z" fill="#d9822b"/><line x1="14" y1="26" x2="28" y2="15" stroke="#8a4b12" stroke-width="1"/>'),
    ("冬", 4, BLUE, "".join(f'<line x1="22" y1="20" x2="{22+10*math.cos(a):.1f}" y2="{20+10*math.sin(a):.1f}" stroke="#5a8fd6" stroke-width="1.8" stroke-linecap="round"/>' for a in [i*math.pi/3 for i in range(6)])),
    ("梅", 1, RED, petals(22, 20, 5, "#e0475b")),
    ("蘭", 2, P["C_ORCHID"], f'<path d="M16 30 C 18 18, 24 12, 30 10" stroke="{GREEN}" stroke-width="1.8" fill="none"/><path d="M20 30 C 14 22, 12 16, 12 12" stroke="{GREEN}" stroke-width="1.5" fill="none"/>' + petals(28, 13, 3.2, "#9b59c4")),
    ("竹", 3, GREEN, stick(20, 20, 20, GREEN, w=4) + f'<path d="M22 16 C 28 12, 34 12, 36 14 C 32 17, 27 18, 22 16 Z" fill="{GREEN}"/>'),
    ("菊", 4, P["C_CHRYS"], petals(22, 20, 5.5, "#f2b705", k=10)),
]

tiles = []
def add(code, key, name, svg):
    tiles.append({"code": code, "file": key, "name": name})
    with open(f"{OUT}/tiles/svg/{key}.svg", "w") as f: f.write(svg)
    cairosvg.svg2png(bytestring=svg.encode(), write_to=f"{OUT}/tiles/png/{key}.png", output_width=W*3, output_height=VB_H*3)

for n in range(1, 10): add(n - 1, f"m{n}", f"{NUMS[n-1]}萬", man(n))
for n in range(1, 10): add(8 + n, f"p{n}", f"{NUMS[n-1]}筒", pin(n))
for n in range(1, 10): add(17 + n, f"s{n}", f"{NUMS[n-1]}條", sou(n))
for i, (ch, k) in enumerate([("東", "e"), ("南", "s"), ("西", "w"), ("北", "n")]):
    add(27 + i, f"wind_{k}", ch, honor(ch, INK))
add(31, "dragon_red", "紅中", honor("中", RED))
add(32, "dragon_green", "青發", honor("發", GREEN))
add(33, "dragon_white", "白板", haku())
for i, (ch, num, col, motif) in enumerate(FLOWERS):
    add(34 + i, f"flower_{i+1}", ch, flower(ch, num, col, motif))

# ---------- 牌背 ----------
def back_frame(inner):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {VB_H}" width="{W*2}" height="{VB_H*2}">'
            f'<rect x="0.5" y="{DEPTH}" width="{W-1}" height="{H-0.5}" rx="6" fill="{FACE_EDGE}"/>'
            f'<rect x="0.5" y="0.5" width="{W-1}" height="{H-1}" rx="6" fill="{BACK}"/>' + inner + '</svg>')

def classic_back():
    return (f'<rect x="5" y="5" width="{W-10}" height="{H-10}" rx="3" fill="none" stroke="#3fa373" stroke-width="1"/>'
            + "".join(f'<path d="M{30} {39-r} L{30+r*0.75} 39 L30 {39+r} L{30-r*0.75} 39 Z" fill="none" stroke="#3fa373" stroke-width="1"/>' for r in (8, 14, 20)))

def bun_back():
    """黃色風格牌背：原創角色「包子寶寶」"""
    dots = "".join(f'<circle cx="{x}" cy="{y}" r="1.3" fill="#fff" opacity="0.45"/>'
                   for x, y in [(10, 10), (50, 12), (8, 66), (52, 68), (14, 38), (47, 36), (30, 8)])
    return (dots +
            f'<rect x="5" y="5" width="{W-10}" height="{H-10}" rx="4" fill="none" stroke="#fff" stroke-opacity="0.6" stroke-width="1" stroke-dasharray="2 2"/>'
            # 蒸籠底
            '<ellipse cx="30" cy="60" rx="19" ry="4" fill="#c46a2f" opacity="0.35"/>'
            # 包子身體
            '<path d="M12 50 C 11 38, 20 29, 30 28 C 40 29, 49 38, 48 50 C 47 58, 40 61, 30 61 C 20 61, 13 58, 12 50 Z" fill="#fffaf0" stroke="#e8c9a0" stroke-width="1"/>'
            # 頂上的摺
            '<path d="M30 28 C 27 31, 24 33, 21 34 M30 28 C 30 32, 30 34, 30 36 M30 28 C 33 31, 36 33, 39 34" stroke="#e2c298" stroke-width="1.1" fill="none" stroke-linecap="round"/>'
            '<path d="M27 27 C 28 24, 32 24, 33 27 C 32 29, 28 29, 27 27 Z" fill="#fffaf0" stroke="#e8c9a0" stroke-width="0.8"/>'
            # 臉
            '<circle cx="24" cy="46" r="1.9" fill="#3b2a1a"/><circle cx="36" cy="46" r="1.9" fill="#3b2a1a"/>'
            '<circle cx="24.6" cy="45.4" r="0.6" fill="#fff"/><circle cx="36.6" cy="45.4" r="0.6" fill="#fff"/>'
            '<ellipse cx="20" cy="50.5" rx="3" ry="1.8" fill="#ff8fa3" opacity="0.8"/><ellipse cx="40" cy="50.5" rx="3" ry="1.8" fill="#ff8fa3" opacity="0.8"/>'
            '<path d="M27.5 50 Q 30 53 32.5 50" stroke="#3b2a1a" stroke-width="1.1" fill="none" stroke-linecap="round"/>'
            # 冒熱氣
            '<path d="M22 22 C 20 19, 24 17, 22 14 M30 20 C 28 17, 32 15, 30 12 M38 22 C 36 19, 40 17, 38 14" stroke="#fff" stroke-opacity="0.8" stroke-width="1.2" fill="none" stroke-linecap="round"/>')

def chip_sparkles(pts):
    return "".join(f'<path d="M{x} {y-2.2} Q{x+0.4} {y-0.4} {x+2.2} {y} Q{x+0.4} {y+0.4} {x} {y+2.2} Q{x-0.4} {y+0.4} {x-2.2} {y} Q{x-0.4} {y-0.4} {x} {y-2.2} Z" fill="#fff" opacity="0.95"/>' for x, y in pts)

BORDER = f'<rect x="5" y="5" width="{W-10}" height="{H-10}" rx="4" fill="none" stroke="#fff" stroke-opacity="0.8" stroke-width="1" stroke-dasharray="2 2"/>'
def chip_face(cx, cy, s=1.0):
    return (f'<g transform="translate({cx} {cy}) scale({s})">'
            '<ellipse cx="-6.5" cy="0" rx="2.8" ry="3.4" fill="#3a2418"/><ellipse cx="6.5" cy="0" rx="2.8" ry="3.4" fill="#3a2418"/>'
            '<circle cx="-5.5" cy="-1.3" r="1.15" fill="#fff"/><circle cx="7.5" cy="-1.3" r="1.15" fill="#fff"/>'
            '<circle cx="-7.3" cy="1.4" r="0.5" fill="#fff"/><circle cx="5.7" cy="1.4" r="0.5" fill="#fff"/>'
            '<path d="M-9.4 -2.2 l-1.7 -1.1 M-8.7 -3.3 l-1.1 -1.7 M9.4 -2.2 l1.7 -1.1 M8.7 -3.3 l1.1 -1.7" stroke="#3a2418" stroke-width="0.85" stroke-linecap="round"/>'
            '<ellipse cx="-11" cy="5" rx="3" ry="1.8" fill="#ff7fa0" opacity="0.75"/><ellipse cx="11" cy="5" rx="3" ry="1.8" fill="#ff7fa0" opacity="0.75"/>'
            '<path d="M-3 4.6 Q 0 8.2 3 4.6 Z" fill="#e8506e" stroke="#3a2418" stroke-width="0.9" stroke-linejoin="round"/>'
            '</g>')
def chip_bow(x, y, rot=-18, s=1.0, col="#ff5c8a", dark="#d93a6a"):
    return (f'<g transform="translate({x} {y}) rotate({rot}) scale({s})">'
            f'<path d="M0 0 C -6 -5, -9 -1, -8 3 C -7 6, -3 5, 0 0 Z M0 0 C 6 -5, 9 -1, 8 3 C 7 6, 3 5, 0 0 Z" fill="{col}" stroke="{dark}" stroke-width="0.8"/>'
            f'<circle cx="0" cy="0.4" r="1.9" fill="#ff85a8" stroke="{dark}" stroke-width="0.7"/></g>')

# ---- A：波浪洋芋片（洋芋片形狀 + 波浪紋 + 捲起的邊）----
CHIP_BORDER = f'<rect x="5" y="5" width="{W-10}" height="{H-10}" rx="4" fill="none" stroke="#fff" stroke-opacity="0.8" stroke-width="1" stroke-dasharray="2 2"/>'

def chip_back():
    """薯片風格牌背：原創角色「脆脆薯片妹」，從洋芋片袋探出頭"""
    bag = ('<path d="M10 46 L 50 46 L 53 72 C 40 74, 20 74, 7 72 Z" fill="#ff6b9a" stroke="#d93a6a" stroke-width="1"/>'
           '<path d="M10 46 L 12 43 L 14 46 L 16 43 L 18 46 L 20 43 L 22 46 L 24 43 L 26 46 L 28 43 L 30 46 L 32 43 L 34 46 L 36 43 L 38 46 L 40 43 L 42 46 L 44 43 L 46 46 L 48 43 L 50 46 Z" fill="#ff8fb3" stroke="#d93a6a" stroke-width="0.8" stroke-linejoin="round"/>'
           '<rect x="17" y="56" width="26" height="12" rx="6" fill="#fff" opacity="0.95"/>')
    label = ('<path d="M21 62 q 4 -5 9 0 q 5 5 9 0" stroke="#f0a020" stroke-width="2" fill="none" stroke-linecap="round"/>')
    # 洋芋片妹：波浪邊的圓片從袋口探出
    pts = []
    for i in range(40):
        a = math.pi + i / 39 * math.pi  # 只畫上半部（下半在袋子裡）
        r = 1 + 0.06 * math.sin(a * 7)
        pts.append(f"{30 + 17 * r * math.cos(a):.2f} {45 + 21 * r * math.sin(a):.2f}")
    chip = "M" + " L".join(pts) + " Z"
    ridges = "".join(f'<path d="M{8+i*6} 44 C {14+i*6} 34, {6+i*6} 26, {16+i*6} 14" stroke="#e59a22" stroke-width="1.4" fill="none" opacity="0.45"/>' for i in range(8))
    return (chip_sparkles([(10,12),(50,11),(8,32),(53,30)]) + CHIP_BORDER +
            '<defs><clipPath id="cB"><path d="' + chip + '"/></clipPath>'
            '<radialGradient id="gB" cx="45%" cy="55%" r="70%"><stop offset="0" stop-color="#ffe08a"/><stop offset="1" stop-color="#f2ad36"/></radialGradient></defs>'
            f'<path d="{chip}" fill="url(#gB)" stroke="#d4861a" stroke-width="1"/>'
            f'<g clip-path="url(#cB)">{ridges}</g>'
            + chip_face(30, 34, 0.85) + chip_bow(17, 26, -20, 0.85)
            + bag + label
            # 小手搭在袋口
            + '<ellipse cx="17" cy="45" rx="3" ry="2.2" fill="#f7b733" stroke="#d4861a" stroke-width="0.8"/><ellipse cx="43" cy="45" rx="3" ry="2.2" fill="#f7b733" stroke="#d4861a" stroke-width="0.8"/>')

def owl_back():
    """黑色風格牌背：原創角色「夜貓頭鷹」"""
    stars = "".join(f'<path d="M{x} {y-1.8} L{x+0.5} {y-0.5} L{x+1.8} {y} L{x+0.5} {y+0.5} L{x} {y+1.8} L{x-0.5} {y+0.5} L{x-1.8} {y} L{x-0.5} {y-0.5} Z" fill="#ffe08a" opacity="0.85"/>'
                    for x, y in [(10, 11), (48, 9), (52, 30), (9, 34), (15, 66), (50, 64)])
    return (stars +
            f'<rect x="5" y="5" width="{W-10}" height="{H-10}" rx="4" fill="none" stroke="#d8b36a" stroke-opacity="0.55" stroke-width="1"/>'
            '<circle cx="44" cy="16" r="5" fill="#ffe8a8"/><circle cx="46.5" cy="14.5" r="4.2" fill="#26304d"/>'
            # 樹枝
            '<path d="M8 62 C 20 60, 38 61, 52 58" stroke="#8a6440" stroke-width="3" fill="none" stroke-linecap="round"/>'
            '<path d="M46 59 C 49 55, 52 54, 55 54 C 53 57, 50 59, 46 59 Z" fill="#5fae6a"/>'
            # 身體
            '<path d="M18 34 L 17 25 L 23 30 C 26 29, 34 29, 37 30 L 43 25 L 42 34 C 45 40, 45 50, 40 56 C 36 60, 24 60, 20 56 C 15 50, 15 40, 18 34 Z" fill="#9a7654"/>'
            '<ellipse cx="30" cy="49" rx="8.5" ry="8" fill="#e6d2b0"/>'
            '<path d="M26 46 l1.2 1.4 l1.2 -1.4 M31.6 46 l1.2 1.4 l1.2 -1.4 M28.8 51 l1.2 1.4 l1.2 -1.4" stroke="#b89468" stroke-width="0.8" fill="none"/>'
            # 翅膀
            '<path d="M17 40 C 13 45, 14 52, 19 56 C 19 50, 19 45, 17 40 Z M43 40 C 47 45, 46 52, 41 56 C 41 50, 41 45, 43 40 Z" fill="#7a5a3e"/>'
            # 眼睛
            '<circle cx="24.5" cy="37" r="5.2" fill="#fff"/><circle cx="35.5" cy="37" r="5.2" fill="#fff"/>'
            '<circle cx="25.2" cy="37.5" r="2.6" fill="#1d1d24"/><circle cx="34.8" cy="37.5" r="2.6" fill="#1d1d24"/>'
            '<circle cx="26" cy="36.5" r="0.9" fill="#fff"/><circle cx="35.6" cy="36.5" r="0.9" fill="#fff"/>'
            # 嘴與腳
            '<path d="M28.3 41.5 L 31.7 41.5 L 30 44.5 Z" fill="#f2a33a"/>'
            '<path d="M25 59 l -1 2.5 M27 59 l 0 2.8 M33 59 l 0 2.8 M35 59 l 1 2.5" stroke="#f2a33a" stroke-width="1.2" stroke-linecap="round"/>')

BACK_ART = {"classic": classic_back, "yellow": bun_back, "black": owl_back, "chips": chip_back}[SKIN]()
back = back_frame(BACK_ART)
with open(f"{OUT}/tiles/svg/back.svg", "w") as f: f.write(back)
cairosvg.svg2png(bytestring=back.encode(), write_to=f"{OUT}/tiles/png/back.png", output_width=W*3, output_height=VB_H*3)

# 側躺（他家看到的牌側面）與立牌背面
SB = round((VB_H - 14.5) / H, 3)  # 牌背圖案縮放比例，讓圖案放進立牌露出的牌背區
standing = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {VB_H}" width="{W*2}" height="{VB_H*2}">'
            f'<rect x="0.5" y="0.5" width="{W-1}" height="{VB_H-1}" rx="6" fill="{BACK}"/>'
            # 他家立著的牌，看到的是牌背：把牌背圖案縮進上方的牌背區（高 {VB_H-14}）
            # 對家的牌在畫面上整排轉 180 度，圖案先倒過來放，對家那排看起來才是正的
            f'<g transform="rotate(180 {W/2} {(VB_H-14)/2:.2f}) translate({W*(1-SB)/2:.2f} 0.5) scale({SB})">{BACK_ART}</g>'
            f'<rect x="0.5" y="{VB_H-14}" width="{W-1}" height="13.5" rx="5" fill="{FACE}" stroke="{FACE_EDGE}"/></svg>')
with open(f"{OUT}/tiles/svg/standing_back.svg", "w") as f: f.write(standing)
cairosvg.svg2png(bytestring=standing.encode(), write_to=f"{OUT}/tiles/png/standing_back.png", output_width=W*3, output_height=VB_H*3)

with open(f"{OUT}/tiles/manifest.json", "w") as f:
    json.dump({"tile_size": {"face_w": W, "face_h": H, "depth": DEPTH, "viewBox_h": VB_H},
               "encoding": "code 0-41 對應規格書第 6.3 節", "tiles": tiles}, f, ensure_ascii=False, indent=2)

# ---------- 各風格的牌桌背景 ----------
TABLES = {
    "classic": ("#1f8a57", "#156b43", "#0b3f27", "#6b4423", "#c9a060"),
    "yellow": ("#3d8fd1", "#2a6aa8", "#16406e", "#f0c75e", "#fff2c2"),
    "black": ("#8a2a3a", "#651c2a", "#3a0d17", "#1c1c1f", "#d8b36a"),
    "chips": ("#4f6fb8", "#34518f", "#172a55", "#fff3b0", "#ffffff"),
}
def table_svg(c1, c2, c3, wood, trim):
    TW, TH = 1920, 1080
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {TW} {TH}" width="{TW}" height="{TH}">'
            f'<defs><radialGradient id="felt" cx="50%" cy="50%" r="70%"><stop offset="0" stop-color="{c1}"/>'
            f'<stop offset="0.65" stop-color="{c2}"/><stop offset="1" stop-color="{c3}"/></radialGradient>'
            '<pattern id="weave" width="6" height="6" patternUnits="userSpaceOnUse"><path d="M0 6 L6 0" stroke="#ffffff" stroke-opacity="0.025" stroke-width="1"/></pattern></defs>'
            f'<rect width="{TW}" height="{TH}" fill="url(#felt)"/><rect width="{TW}" height="{TH}" fill="url(#weave)"/>'
            f'<rect x="24" y="24" width="{TW-48}" height="{TH-48}" rx="28" fill="none" stroke="{wood}" stroke-width="18" opacity="0.9"/>'
            f'<rect x="36" y="36" width="{TW-72}" height="{TH-72}" rx="20" fill="none" stroke="{trim}" stroke-width="2" opacity="0.6"/>'
            '</svg>')
if SKIN != "classic":
    open(f"{OUT}/table/table_bg.svg", "w").write(table_svg(*TABLES[SKIN]))
    # 總覽圖
    keys = [t["file"] for t in tiles] + ["back", "standing_back"]
    cols = 10
    def inner_of(k):
        raw = open(f"{OUT}/tiles/svg/{k}.svg").read()
        return raw[raw.index(">") + 1: raw.rindex("</svg>")]
    rows = math.ceil(len(keys) / cols)
    sheet = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {cols*70+20} {rows*100+20}"><rect width="100%" height="100%" fill="{TABLES[SKIN][1]}"/>' + "".join(
        f'<g transform="translate({15 + (i % cols) * 70},{12 + (i // cols) * 100})">{inner_of(k)}</g>' for i, k in enumerate(keys)) + "</svg>"
    cairosvg.svg2png(bytestring=sheet.encode(), write_to=f"{OUT}/tiles_overview.png", output_width=(cols*70+20)*2)
    print("skin", SKIN, "done")
    sys.exit(0)

# ---------- UI 按鈕 ----------
BTN = [("chi", "吃", "#2e7d32"), ("pon", "碰", "#1565c0"), ("kan", "槓", "#6a1b9a"),
       ("hu", "胡", "#c62828"), ("zimo", "自摸", "#c62828"), ("ting", "聽", "#ef6c00"), ("pass", "過", "#546e7a")]
def button(label, color):
    w, h = 120, 56
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h+4}" width="{w*2}" height="{(h+4)*2}">'
            f'<rect x="1" y="5" width="{w-2}" height="{h-2}" rx="{h/2-1}" fill="#000" opacity="0.25"/>'
            f'<rect x="1" y="1" width="{w-2}" height="{h-2}" rx="{h/2-1}" fill="{color}" stroke="#ffffff" stroke-opacity="0.6" stroke-width="2"/>'
            f'<rect x="8" y="5" width="{w-16}" height="{h/2-6}" rx="{h/4}" fill="#fff" opacity="0.15"/>'
            + text_run(label, w / 2, h / 2, 30 if len(label) == 1 else 26, "#ffffff") + '</svg>')
for key, label, color in BTN:
    svg = button(label, color)
    open(f"{OUT}/ui/svg/btn_{key}.svg", "w").write(svg)
    cairosvg.svg2png(bytestring=svg.encode(), write_to=f"{OUT}/ui/png/btn_{key}.png", output_width=360)

# 骰子 1–6
PIPS = {1: [(0, 0)], 2: [(-1, -1), (1, 1)], 3: [(-1, -1), (0, 0), (1, 1)], 4: [(-1, -1), (1, -1), (-1, 1), (1, 1)],
        5: [(-1, -1), (1, -1), (0, 0), (-1, 1), (1, 1)], 6: [(-1, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (1, 1)]}
for n, pips in PIPS.items():
    red = n in (1, 4)
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60" width="120" height="120">'
           '<rect x="2" y="2" width="56" height="56" rx="10" fill="#fdfdfd" stroke="#c9c9c9" stroke-width="2"/>'
           + "".join(f'<circle cx="{30+x*14}" cy="{30+y*14}" r="{9 if n==1 else 5.2}" fill="{RED if red else "#222"}"/>' for x, y in pips) + '</svg>')
    open(f"{OUT}/ui/svg/dice_{n}.svg", "w").write(svg)
    cairosvg.svg2png(bytestring=svg.encode(), write_to=f"{OUT}/ui/png/dice_{n}.png", output_width=180)

# 標記：莊、豹子、圈風、倒數
def badge(txt, color, w=64, h=64, size=34, circle=True):
    shape = (f'<circle cx="{w/2}" cy="{h/2}" r="{w/2-2}" fill="{color}" stroke="#fff" stroke-width="3"/>' if circle else
             f'<rect x="2" y="2" width="{w-4}" height="{h-4}" rx="12" fill="{color}" stroke="#fff" stroke-width="3"/>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w*2}" height="{h*2}">' + shape
            + text_run(txt, w / 2, h / 2, size, "#fff") + '</svg>')
BADGES = {"badge_dealer": badge("莊", RED), "badge_leopard": badge("豹子", "#d4a017", w=120, h=56, size=30, circle=False),
          "badge_ting": badge("聽", "#ef6c00")}
for k, ch in zip("eswn", "東南西北"):
    BADGES[f"badge_wind_{k}"] = badge(ch, "#1d2a44")
for k, svg in BADGES.items():
    open(f"{OUT}/ui/svg/{k}.svg", "w").write(svg)
    cairosvg.svg2png(bytestring=svg.encode(), write_to=f"{OUT}/ui/png/{k}.png", output_width=240 if "leopard" in k else 128)

# ---------- 牌桌背景 1920x1080 ----------
TW, TH = 1920, 1080
table = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {TW} {TH}" width="{TW}" height="{TH}">'
         '<defs><radialGradient id="felt" cx="50%" cy="50%" r="70%"><stop offset="0" stop-color="#1f8a57"/>'
         '<stop offset="0.65" stop-color="#156b43"/><stop offset="1" stop-color="#0b3f27"/></radialGradient>'
         '<pattern id="weave" width="6" height="6" patternUnits="userSpaceOnUse"><path d="M0 6 L6 0" stroke="#ffffff" stroke-opacity="0.025" stroke-width="1"/></pattern></defs>'
         f'<rect width="{TW}" height="{TH}" fill="url(#felt)"/><rect width="{TW}" height="{TH}" fill="url(#weave)"/>'
         f'<rect x="24" y="24" width="{TW-48}" height="{TH-48}" rx="28" fill="none" stroke="#6b4423" stroke-width="18" opacity="0.9"/>'
         f'<rect x="36" y="36" width="{TW-72}" height="{TH-72}" rx="20" fill="none" stroke="#c9a060" stroke-width="2" opacity="0.6"/>'
         '</svg>')
open(f"{OUT}/table/table_bg.svg", "w").write(table)
cairosvg.svg2png(bytestring=table.encode(), write_to=f"{OUT}/table/table_bg.png")

# ---------- 牌桌畫面草圖（手機橫式 1920x1080 示意） ----------
def use_tile(key, x, y, scale=1.0, rot=0):
    """把牌 SVG 以 <g> 嵌入；rot 以牌中心旋轉。"""
    inner = open(f"{OUT}/tiles/svg/{key}.svg").read()
    inner = inner[inner.index(">") + 1: inner.rindex("</svg>")]
    return (f'<g transform="translate({x},{y}) rotate({rot},{W*scale/2},{VB_H*scale/2}) scale({scale})">{inner}</g>')

def use_ui(key, x, y, scale=1.0, folder="ui/svg"):
    raw = open(f"{OUT}/{folder}/{key}.svg").read()
    vb = raw.split('viewBox="')[1].split('"')[0].split()
    inner = raw[raw.index(">") + 1: raw.rindex("</svg>")]
    return f'<g transform="translate({x},{y}) scale({scale})">{inner}</g>', float(vb[2]) * scale, float(vb[3]) * scale

parts = [table[table.index(">") + 1: table.rindex("</svg>")]]
# 自己手牌（下方，16 張 + 剛摸的牌）
hand = ["m1", "m2", "m3", "m7", "m8", "m9", "p2", "p3", "p4", "p6", "p6", "s5", "s6", "s7", "wind_e", "wind_e"]
s = 1.35; tw = W * s
x0 = (TW - (len(hand) + 1.4) * tw) / 2
for i, k in enumerate(hand):
    lift = -22 if i == 9 else 0  # 被選取的牌抬高
    parts.append(use_tile(k, x0 + i * tw, 900 + lift, s))
parts.append(use_tile("p5", x0 + (len(hand) + 0.4) * tw, 900, s))
# 自己的花牌與副露（手牌上方左側）
for i, k in enumerate(["flower_1", "flower_5"]):
    parts.append(use_tile(k, 150 + i * 44, 795, 0.72))
# 對家（上方）立牌
for i in range(16):
    parts.append(use_tile("standing_back", 560 + i * 50, 70, 0.83))
# 對家副露：碰 中
for i in range(3):
    parts.append(use_tile("dragon_red", 1400 + i * 44, 70, 0.72))
# 上家（左）、下家（右）立牌，以側向排列
for i in range(16):
    parts.append(f'<rect x="90" y="{190 + i*36}" width="40" height="34" rx="4" fill="{BACK}" stroke="{BACK_DARK}"/>'
                 f'<rect x="124" y="{190 + i*36}" width="8" height="34" rx="3" fill="{FACE}"/>')
    parts.append(f'<rect x="{TW-130}" y="{190 + i*36}" width="40" height="34" rx="4" fill="{BACK}" stroke="{BACK_DARK}"/>'
                 f'<rect x="{TW-132}" y="{190 + i*36}" width="8" height="34" rx="3" fill="{FACE}"/>')
# 下家副露：吃 三四五條（直向縮小）
for i, k in enumerate(["s3", "s4", "s5"]):
    parts.append(use_tile(k, TW - 250, 250 + i * 50, 0.62, rot=-90))

# 中央資訊盤
cx, cy = TW / 2, 470
parts.append(f'<rect x="{cx-170}" y="{cy-125}" width="340" height="250" rx="24" fill="#0b2e1d" opacity="0.88" stroke="#c9a060" stroke-width="2"/>')
parts.append(text_run("東風圈", cx, cy - 60, 28, "#f5e6c4"))
parts.append(text_run("剩餘 58 張", cx, cy - 22, 22, "#ffffff"))
parts.append(text_run("連莊 2", cx, cy + 10, 20, "#f5e6c4"))
for i, n in enumerate([4, 4, 4]):
    g, w_, h_ = use_ui(f"dice_{n}", cx - 120 + i * 50, cy + 32, 0.7)
    parts.append(g)
g, w_, h_ = use_ui("badge_leopard", cx + 35, cy + 36, 0.7); parts.append(g)
# 各家門風（自己在下）
for ch, x, y in [("東", cx, cy + 106), ("西", cx, cy - 104), ("南", cx + 148, cy), ("北", cx - 148, cy)]:
    parts.append(text_run(ch, x, y, 24, "#f2b705"))
g, *_ = use_ui("badge_dealer", x0 - 90, 885, 1.0); parts.append(g)

# 各家捨牌區（6 張一列）
def discards(keys, ox, oy, rot, step=40, row=6, sc=0.62):
    out = []
    for i, k in enumerate(keys):
        r, c = divmod(i, row)
        if rot == 0:      x, y = ox + c * step, oy + r * 54
        elif rot == 180:  x, y = ox - c * step, oy - r * 54
        elif rot == 90:   x, y = ox - r * 54, oy + c * step
        else:             x, y = ox + r * 54, oy - c * step
        out.append(use_tile(k, x, y, sc, rot=rot))
    return out
parts += discards(["m9", "wind_n", "s1", "p9", "dragon_white", "m4", "s8"], cx - 120, 610, 0)
parts += discards(["wind_w", "p1", "m5", "s2", "p8"], cx + 80, 268, 180)
parts += discards(["wind_s", "s9", "m2", "p7"], cx - 330, 360, 90)
parts += discards(["m6", "p3", "wind_n", "s6", "dragon_green"], cx + 250, 560, -90)

# 暱稱標籤
for txt, x, y in [("我（阿明）", 150, 990), ("小美", cx, 38), ("AI・普通", 110, 170), ("阿華", TW - 110, 170)]:
    parts.append(f'<rect x="{x-80}" y="{y-20}" width="160" height="40" rx="20" fill="#000" opacity="0.4"/>')
    parts.append(text_run(txt, x, y, 20, "#ffffff"))

# 操作按鈕（手牌右上方）與倒數
bx = TW - 560
for i, key in enumerate(["pon", "hu", "pass"]):
    g, w_, h_ = use_ui(f"btn_{key}", bx + i * 140, 790, 1.0); parts.append(g)
parts.append(f'<circle cx="{bx - 50}" cy="818" r="30" fill="#000" opacity="0.5" stroke="#f2b705" stroke-width="4"/>')
parts.append(text_run("4", bx - 50, 818, 30, "#f2b705"))
# 聽牌提示
parts.append(f'<rect x="{x0}" y="790" width="340" height="56" rx="12" fill="#000" opacity="0.45"/>')
parts.append(text_run("聽：", x0 + 36, 818, 22, "#ffffff"))
for i, k in enumerate(["p5", "p8"]):
    parts.append(use_tile(k, x0 + 70 + i * 120, 794, 0.55))
    parts.append(text_run(["剩 2", "剩 3"][i], x0 + 140 + i * 120, 818, 18, "#f5e6c4"))

mock = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {TW} {TH}" width="{TW}" height="{TH}">' + "".join(parts) + "</svg>"
open(f"{OUT}/mockup/table_mockup.svg", "w").write(mock)
cairosvg.svg2png(bytestring=mock.encode(), write_to=f"{OUT}/mockup/table_mockup.png")

# ---------- 總覽圖 ----------
cols = 10
keys = [t["file"] for t in tiles] + ["back", "standing_back"]
sheet_w = cols * 70 + 20
rows = math.ceil(len(keys) / cols)
sheet = [f'<rect width="{sheet_w}" height="{rows*100+20}" fill="#2b5d45"/>']
for i, k in enumerate(keys):
    r, c = divmod(i, cols)
    sheet.append(use_tile(k, 15 + c * 70, 12 + r * 100, 1.0))
sheet_svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {sheet_w} {rows*100+20}">' + "".join(sheet) + "</svg>"
open(f"{OUT}/tiles_overview.svg", "w").write(sheet_svg)
cairosvg.svg2png(bytestring=sheet_svg.encode(), write_to=f"{OUT}/tiles_overview.png", output_width=sheet_w * 2)
print("done", len(tiles), "tiles")
