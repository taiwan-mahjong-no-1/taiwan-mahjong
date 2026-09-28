"""產生規則測試案例：驗證手牌合法、計算台數合計與各家分數，輸出 JSON 與 Markdown。

牌的寫法：數字 + 花色（m 萬、p 筒、s 條），字牌用大寫：E 東 S 南 W 西 N 北 C 中 F 發 P 白。
花牌：f1-f8 = 春夏秋冬梅蘭竹菊。
座位：E 東 S 南 W 西 N 北；莊家固定坐東（E）。行牌順序 E→S→W→N（逆時針）。
"""
import json, re
from collections import Counter

HONORS = "ESWNCFP"
FLOWER_NAME = dict(zip(["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"], "春夏秋冬梅蘭竹菊"))
SEATS = ["E", "S", "W", "N"]
SEAT_NAME = dict(zip(SEATS, "東南西北"))


def parse(s):
    tiles, digits = [], ""
    for ch in s.replace(" ", ""):
        if ch.isdigit():
            digits += ch
        elif ch in "mps":
            tiles += [d + ch for d in digits]; digits = ""
        elif ch in HONORS:
            tiles.append(ch)
        else:
            raise ValueError(f"bad char {ch} in {s}")
    assert digits == "", s
    return tiles


def key(t):
    return (("mps" + HONORS).index(t[-1] if t[-1] in "mps" else t), int(t[0]) if t[-1] in "mps" else 0)


def can_sets(c, n):
    """c: Counter，能否剛好拆成 n 組面子。"""
    if n == 0:
        return sum(c.values()) == 0
    left = [k for k, v in c.items() if v]
    if not left:
        return False
    t = min(left, key=key)
    if c[t] >= 3:
        c[t] -= 3
        if can_sets(c, n - 1):
            c[t] += 3; return True
        c[t] += 3
    if t[-1] in "mps" and int(t[0]) <= 7:
        a, b = f"{int(t[0])+1}{t[-1]}", f"{int(t[0])+2}{t[-1]}"
        if c[a] and c[b]:
            for x in (t, a, b): c[x] -= 1
            ok = can_sets(c, n - 1)
            for x in (t, a, b): c[x] += 1
            if ok: return True
    return False


def is_win(concealed, n_sets):
    c = Counter(concealed)
    for p in list(c):
        if c[p] >= 2:
            c[p] -= 2
            if can_sets(c, n_sets):
                return "standard"
            c[p] += 2
    if n_sets == 5:  # 嚦咕嚦咕：七對加一刻
        vals = sorted(c.values())
        if len(concealed) == 17 and vals.count(3) == 1 and all(v in (2, 3) for v in vals) and len(vals) == 8:
            return "lig"
    return None


def pay(case):
    """依規格書計算各家分數變化。"""
    base, per, mult = case.get("base", 30), case.get("perTai", 10), 2 if case.get("leopard") else 1
    deltas = {s: 0 for s in SEATS}
    notes = []
    for fb in case.get("flowerBonus", []):
        payers = [s for s in SEATS if s != fb["to"]] if fb["kind"] == "八仙過海" else [fb["from"]]
        for p in payers:
            amt = 8 * mult * per
            deltas[p] -= amt; deltas[fb["to"]] += amt
    w = case.get("winner")
    if w:
        hand = sum(t for _, t in case["tai"])
        streak = case.get("dealerStreak", 0)
        dealer_tai = 0 if case.get("noDealerTai") else 1 + 2 * streak
        payers = case["winners"] if False else None
        if case["winType"] == "self":
            payers = [s for s in SEATS if s != w]
        else:
            payers = [case["discarder"]]
        for p in payers:
            dt = dealer_tai if ("E" in (w, p)) else 0
            amt = (base + (hand + dt) * per) * mult
            deltas[p] -= amt; deltas[w] += amt
    for extra in case.get("extraWins", []):  # 一炮多響的其他胡牌者
        hand = sum(t for _, t in extra["tai"])
        p = case["discarder"]
        dt = (1 + 2 * case.get("dealerStreak", 0)) if "E" in (extra["winner"], p) else 0
        amt = (base + (hand + dt) * per) * mult
        deltas[p] -= amt; deltas[extra["winner"]] += amt
    assert sum(deltas.values()) == 0
    return deltas


CASES = []
def case(**kw):
    CASES.append(kw)

# 通用：圈風東、莊家坐東、贏家坐南、西家放槍、底 30、每台 10
BASIC = dict(concealed="456m789m234p678sNN", melds=[("chi", "123m")], winTile="6s")

# ---------- 一、基本 ----------
case(id="B01", group="基本", title="放槍、無台", winner="S", winType="discard", discarder="W", **BASIC, tai=[])
case(id="B02", group="基本", title="門清放槍", winner="S", winType="discard", discarder="W",
     concealed="123m456m789m234p678sNN", melds=[], winTile="6s", tai=[("門清", 1)])
case(id="B03", group="基本", title="自摸（有吃牌）", winner="S", winType="self", **BASIC, tai=[("自摸", 1)])
case(id="B04", group="基本", title="門清自摸", winner="S", winType="self",
     concealed="123m456m789m234p678sNN", melds=[], winTile="6s", tai=[("門清自摸", 3)])

# ---------- 二、莊家與連莊 ----------
case(id="D01", group="莊家與連莊", title="閒家胡、莊家放槍", winner="S", winType="discard", discarder="E", **BASIC, tai=[],
     note="莊家放槍要多付莊家 1 台")
case(id="D02", group="莊家與連莊", title="莊家胡、連 2 拉 2", winner="E", winType="discard", discarder="S", dealerStreak=2, **BASIC, tai=[],
     note="莊家 1 + 連莊 2×2 = 5 台，由放槍者付")
case(id="D03", group="莊家與連莊", title="莊家自摸、連 1", winner="E", winType="self", dealerStreak=1, **BASIC, tai=[("自摸", 1)],
     note="三家都付 莊家 1 + 連莊 2 + 自摸 1")
case(id="D04", group="莊家與連莊", title="閒家自摸、莊家連 3", winner="S", winType="self", dealerStreak=3, **BASIC, tai=[("自摸", 1)],
     note="只有莊家多付 莊家 1 + 連莊 6")
case(id="D05", group="莊家與連莊", title="閒家胡莊家、莊家連 2", winner="S", winType="discard", discarder="E", dealerStreak=2, **BASIC, tai=[],
     note="莊家放槍多付 1 + 4 = 5 台")
case(id="D06", group="莊家與連莊", title="閒家互相放槍、莊家連 2", winner="S", winType="discard", discarder="W", dealerStreak=2, **BASIC, tai=[],
     note="莊家不在其中，不計莊家與連莊")

# ---------- 三、字牌刻子 ----------
case(id="H01", group="字牌", title="圈風＋門風刻（南風圈、南家）", roundWind="S", winner="S", winType="discard", discarder="W",
     concealed="123m456m789p345s99s", melds=[("pon", "SSS")], winTile="3s", tai=[("圈風刻", 1), ("門風刻", 1)])
case(id="H02", group="字牌", title="非自己風的風刻不計台", winner="S", winType="discard", discarder="W",
     concealed="123m456m789p345s99s", melds=[("pon", "NNN")], winTile="3s", tai=[])
case(id="H03", group="字牌", title="兩組三元牌刻", winner="S", winType="discard", discarder="W",
     concealed="123m456p345s99s", melds=[("pon", "CCC"), ("pon", "FFF")], winTile="3s", tai=[("三元牌刻 中", 1), ("三元牌刻 發", 1)])

# ---------- 四、花牌（胡牌時計） ----------
case(id="F01", group="花牌", title="正花 2 張（南家：夏、蘭）", winner="S", winType="discard", discarder="W", **BASIC,
     flowers=["f1", "f2", "f6"], tai=[("正花 夏", 1), ("正花 蘭", 1)], note="春不是南家的正花")
case(id="F02", group="花牌", title="花槓（春夏秋冬）＋正花", winner="S", winType="discard", discarder="W", **BASIC,
     flowers=["f1", "f2", "f3", "f4"], tai=[("花槓", 2), ("正花 夏", 1)])
case(id="F03", group="花牌", title="東家正花（春、梅）", winner="E", winType="discard", discarder="S", **BASIC,
     flowers=["f1", "f5"], tai=[("正花 春", 1), ("正花 梅", 1)], note="另加莊家 1 台")

# ---------- 五、聽牌型 ----------
case(id="T01", group="聽牌型", title="獨聽：單吊", winner="S", winType="discard", discarder="W",
     concealed="456m789m234p567sNN", melds=[("chi", "123m")], winTile="N", tai=[("獨聽", 1)])
case(id="T02", group="聽牌型", title="獨聽：邊張（12 聽 3）", winner="S", winType="discard", discarder="W",
     concealed="456m789m123p567sNN", melds=[("chi", "123m")], winTile="3p", tai=[("獨聽", 1)])
case(id="T03", group="聽牌型", title="獨聽：中洞（13 聽 2）", winner="S", winType="discard", discarder="W",
     concealed="456m789m123p567sNN", melds=[("chi", "123m")], winTile="2p", tai=[("獨聽", 1)])
case(id="T04", group="聽牌型", title="兩面聽不算獨聽", winner="S", winType="discard", discarder="W", **BASIC, tai=[],
     note="78 條聽 6、9 條")
case(id="T05", group="聽牌型", title="對碰（雙碰）不算獨聽", winner="S", winType="discard", discarder="W",
     concealed="777p33s456m789m234p", melds=[("chi", "123s")], winTile="7p", tai=[], note="聽 7 筒與 3 條")
TING = dict(concealed="123m456m789p234s678sNN", melds=[], winTile="6s")  # 報聽後不能吃碰，所以用門清手牌
case(id="T06", group="聽牌型", title="咪幾：前 8 張出牌內報聽", winner="S", winType="discard", discarder="W", **TING,
     tai=[("門清", 1), ("咪幾", 4)], note="全桌前 8 張出牌內報聽、期間無人吃碰槓；須按「聽」才算")
case(id="T07", group="聽牌型", title="天聽：莊家第一張牌即報聽", winner="E", winType="discard", discarder="W", **TING,
     tai=[("門清", 1), ("天聽", 8)], note="另加莊家 1 台")
case(id="T08", group="聽牌型", title="天聽不再疊加咪幾", winner="E", winType="discard", discarder="W", **TING,
     tai=[("門清", 1), ("天聽", 8)], note="天聽同時符合咪幾條件，只算天聽；另加莊家 1 台")

# ---------- 六、平胡 ----------
PH = dict(concealed="123m456m789p234s678s55p", melds=[], winTile="6s")
case(id="P01", group="平胡", title="平胡＋門清", winner="S", winType="discard", discarder="W", **PH, tai=[("門清", 1), ("平胡", 2)])
case(id="P02", group="平胡", title="有花就不是平胡", winner="S", winType="discard", discarder="W", **PH, flowers=["f3"], tai=[("門清", 1)],
     note="秋不是南家正花，所以也沒有正花台")
case(id="P03", group="平胡", title="自摸就不是平胡", winner="S", winType="self", **PH, tai=[("門清自摸", 3)])
case(id="P04", group="平胡", title="獨聽就不是平胡", winner="S", winType="discard", discarder="W",
     concealed="123m456m789p234s789s55p", melds=[], winTile="8s", tai=[("門清", 1), ("獨聽", 1)], note="79 條中洞聽 8 條")
case(id="P05", group="平胡", title="有字牌就不是平胡", winner="S", winType="discard", discarder="W",
     concealed="123m456m789m234p678sNN", melds=[], winTile="6s", tai=[("門清", 1)])

# ---------- 七、刻子與暗刻 ----------
case(id="K01", group="刻子與暗刻", title="碰碰胡", winner="S", winType="discard", discarder="W",
     concealed="777p33s", melds=[("pon", "222m"), ("pon", "555p"), ("pon", "888s"), ("pon", "999m")], winTile="7p",
     tai=[("碰碰胡", 4)], note="7 筒由放槍完成，不算暗刻")
case(id="K02", group="刻子與暗刻", title="碰碰胡＋三暗刻＋單吊", winner="S", winType="discard", discarder="W",
     concealed="111s999s777pNN", melds=[("pon", "222m"), ("pon", "555p")], winTile="N",
     tai=[("碰碰胡", 4), ("三暗刻", 2), ("獨聽", 1)])
case(id="K03", group="刻子與暗刻", title="放槍完成的刻子不算暗刻", winner="S", winType="discard", discarder="W",
     concealed="111m555m999p22s777s", melds=[("chi", "123p")], winTile="7s", tai=[("三暗刻", 2)],
     note="同一副牌若自摸 7 條，就變成四暗刻（見 K04）")
case(id="K04", group="刻子與暗刻", title="同 K03 但自摸：四暗刻", winner="S", winType="self",
     concealed="111m555m999p22s777s", melds=[("chi", "123p")], winTile="7s", tai=[("四暗刻", 5), ("自摸", 1)],
     note="只取最高的暗刻台數")
case(id="K05", group="刻子與暗刻", title="四暗刻＋碰碰胡＋自摸單吊", winner="S", winType="self",
     concealed="111s999s777p444mNN", melds=[("pon", "222m")], winTile="N",
     tai=[("四暗刻", 5), ("碰碰胡", 4), ("自摸", 1), ("獨聽", 1)])
case(id="K06", group="刻子與暗刻", title="五暗刻門清自摸", winner="S", winType="self",
     concealed="111m555m999p222s777sNN", melds=[], winTile="N",
     tai=[("五暗刻", 8), ("碰碰胡", 4), ("門清自摸", 3), ("獨聽", 1)])
case(id="K07", group="刻子與暗刻", title="暗槓仍算門清", winner="S", winType="discard", discarder="W",
     concealed="456m789m234p678sNN", melds=[("ankan", "5555s")], winTile="6s", tai=[("門清", 1)],
     note="只有 1 組暗刻（暗槓），不計暗刻台")

# ---------- 八、一色與大牌 ----------
case(id="L01", group="一色與大牌", title="混一色", winner="S", winType="discard", discarder="W",
     concealed="123m456m678m789m99m", melds=[("pon", "NNN")], winTile="8m", tai=[("混一色", 4)])
case(id="L02", group="一色與大牌", title="清一色門清自摸", winner="S", winType="self",
     concealed="123p456p678p789p234p55p", melds=[], winTile="1p", tai=[("清一色", 8), ("門清自摸", 3)])
case(id="L03", group="一色與大牌", title="小三元（另計兩組三元牌刻）", winner="S", winType="discard", discarder="W",
     concealed="123m456p789mPP", melds=[("pon", "CCC"), ("pon", "FFF")], winTile="9m",
     tai=[("小三元", 4), ("三元牌刻 中", 1), ("三元牌刻 發", 1)])
case(id="L04", group="一色與大牌", title="大三元（不另計三元牌刻）", winner="S", winType="discard", discarder="W",
     concealed="123m789m55p", melds=[("pon", "CCC"), ("pon", "FFF"), ("pon", "PPP")], winTile="9m", tai=[("大三元", 8)])
case(id="L05", group="一色與大牌", title="小四喜＋混一色", winner="S", winType="discard", discarder="W",
     concealed="123m789mNN", melds=[("pon", "EEE"), ("pon", "SSS"), ("pon", "WWW")], winTile="9m",
     tai=[("小四喜", 8), ("混一色", 4)], note="不另計圈風刻、門風刻")
case(id="L06", group="一色與大牌", title="大四喜＋混一色＋邊張", winner="S", winType="discard", discarder="W",
     concealed="123m55m", melds=[("pon", "EEE"), ("pon", "SSS"), ("pon", "WWW"), ("pon", "NNN")], winTile="3m",
     tai=[("大四喜", 16), ("混一色", 4), ("獨聽", 1)])
case(id="L07", group="一色與大牌", title="字一色＋小四喜＋碰碰胡", winner="S", winType="discard", discarder="W",
     concealed="WWWNN", melds=[("pon", "EEE"), ("pon", "SSS"), ("pon", "CCC"), ("pon", "FFF")], winTile="N",
     tai=[("字一色", 16), ("小四喜", 8), ("碰碰胡", 4), ("三元牌刻 中", 1), ("三元牌刻 發", 1), ("獨聽", 1)],
     note="西西西是暗刻但只有 1 組；字一色不另計混一色")
case(id="L08", group="一色與大牌", title="嚦咕嚦咕放槍", winner="S", winType="discard", discarder="W",
     concealed="11m55m99m22p77p33s88sNNN", melds=[], winTile="N", tai=[("嚦咕嚦咕", 8)],
     note="胡前是 8 對，可胡任何一對，不算獨聽；不另計門清")
case(id="L09", group="一色與大牌", title="嚦咕嚦咕＋清一色＋自摸", winner="S", winType="self",
     concealed="11s22s44s55s66s77s88s999s", melds=[], winTile="9s", tai=[("嚦咕嚦咕", 8), ("清一色", 8), ("自摸", 1)])

# ---------- 九、特殊胡 ----------
case(id="X01", group="特殊胡", title="搶槓", winner="S", winType="discard", discarder="W", **BASIC, tai=[("搶槓", 1)],
     note="西家把碰過的 6 條加槓，南家搶這張 6 條胡；由西家付")
case(id="X02", group="特殊胡", title="暗槓不能被搶", expectNoWin=True, note="西家暗槓 5 筒，南家聽 5 筒也不能胡；對局繼續")
case(id="X03", group="特殊胡", title="槓上開花（加槓）", winner="S", winType="self",
     concealed="456m789m234s678sNN", melds=[("kakan", "7777p")], winTile="6s", tai=[("槓上開花", 1), ("自摸", 1)],
     note="加槓、暗槓補牌可以自摸；大明槓（槓別人打的牌）補牌不能自摸，所以沒有大明槓的槓上開花")
case(id="X04", group="特殊胡", title="槓上開花（暗槓，仍門清）", winner="S", winType="self",
     concealed="456m789m234s678sNN", melds=[("ankan", "7777p")], winTile="6s", tai=[("槓上開花", 1), ("門清自摸", 3)])
case(id="X05", group="特殊胡", title="海底撈月", winner="S", winType="self", **BASIC, tai=[("海底撈月", 1), ("自摸", 1)])
case(id="X06", group="特殊胡", title="河底撈魚", winner="S", winType="discard", discarder="W", **BASIC, tai=[("河底撈魚", 1)])
case(id="X07", group="特殊胡", title="半求（自摸單吊）", winner="S", winType="self",
     concealed="NN", melds=[("chi", "123m"), ("chi", "456m"), ("chi", "789p"), ("chi", "234s"), ("chi", "567s")], winTile="N",
     tai=[("半求", 1), ("自摸", 1)], note="半求、全求不另計獨聽")
case(id="X08", group="特殊胡", title="全求（胡他家單吊）", winner="S", winType="discard", discarder="W",
     concealed="NN", melds=[("chi", "123m"), ("chi", "456m"), ("chi", "789p"), ("chi", "234s"), ("chi", "567s")], winTile="N",
     tai=[("全求", 2)])
case(id="X09", group="特殊胡", title="天胡", winner="E", winType="self", noDealerTai=True,
     concealed="123m456m789m234p678sNN", melds=[], winTile="6s", tai=[("天胡", 24)], note="固定 24 台，不另計莊家與其他台")
case(id="X10", group="特殊胡", title="地胡", winner="S", winType="self",
     concealed="123m456m789m234p678sNN", melds=[], winTile="6s", tai=[("地胡", 16), ("門清自摸", 3)],
     note="地胡可與其他台疊加；莊家另付莊家 1 台")

# ---------- 十、豹子 ----------
case(id="Y01", group="豹子加倍", title="豹子局門清自摸", winner="S", winType="self", leopard=True,
     concealed="123m456m789m234p678sNN", melds=[], winTile="6s", tai=[("門清自摸", 3)], note="（底 + 台）算完後整筆加倍；莊家的 1 台也在內")
case(id="Y02", group="豹子加倍", title="豹子局單吊放槍", winner="S", winType="discard", discarder="W", leopard=True,
     concealed="456m789m234p567sNN", melds=[("chi", "123m")], winTile="N", tai=[("獨聽", 1)])
case(id="Y03", group="豹子加倍", title="豹子局莊家胡、連 1", winner="E", winType="discard", discarder="S", leopard=True, dealerStreak=1,
     **BASIC, tai=[], note="(底 30 + (莊家 1 + 連莊 2) × 10) × 2 = 120")

# ---------- 十一、八仙過海與七搶一 ----------
case(id="G01", group="八仙過海與七搶一", title="八仙過海，之後同一人門清自摸", winner="S", winType="self",
     concealed="123m456m789m234p678sNN", melds=[], winTile="6s",
     flowers=["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"], flowerBonus=[{"kind": "八仙過海", "to": "S"}],
     tai=[("門清自摸", 3)], note="集滿時先向三家各收 8 台；之後胡牌不再計正花、花槓")
case(id="G02", group="八仙過海與七搶一", title="八仙過海，之後流局", flowers=["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"],
     flowerBonus=[{"kind": "八仙過海", "to": "S"}], note="流局不查聽，花牌收分照算；莊家連莊")
case(id="G03", group="八仙過海與七搶一", title="八仙過海，之後別人胡", winner="W", winType="discard", discarder="N",
     concealed="456m789m234p678sNN", melds=[("chi", "123m")], winTile="6s",
     flowerBonus=[{"kind": "八仙過海", "to": "S"}], tai=[], note="南家先收 8 台，北家再放槍給西家")
case(id="G04", group="八仙過海與七搶一", title="豹子局八仙過海", leopard=True, flowerBonus=[{"kind": "八仙過海", "to": "S"}],
     note="每家付 16 台")
case(id="G05", group="八仙過海與七搶一", title="七搶一", flowerBonus=[{"kind": "七搶一", "to": "S", "from": "W"}],
     note="南家 7 張、西家 1 張，只由西家賠 8 台")
case(id="G06", group="八仙過海與七搶一", title="8 張花分在三家不成立", expectNoWin=True,
     note="南家 6 張、西家 1 張、北家 1 張：沒有八仙過海也沒有七搶一")
case(id="G07", group="八仙過海與七搶一", title="開局補花就湊齊八仙過海", flowerBonus=[{"kind": "八仙過海", "to": "S"}],
     note="當場收分，照常開始打牌")

# ---------- 十二、宣告與流程 ----------
case(id="R01", group="宣告與流程", title="一炮雙響", winner="S", winType="discard", discarder="W", **BASIC, tai=[],
     extraWins=[{"winner": "N", "tai": [("門清", 1)]}], note="房間設定為一炮多響：西家分別付南家、北家（北家門清 1 台）")
case(id="R02", group="宣告與流程", title="截胡", winner="N", winType="discard", discarder="W",
     concealed="123m456m789m234p678sNN", melds=[], winTile="6s", tai=[("門清", 1)],
     note="南家、北家都能胡西家的 6 條；從西家逆時針最近的是北家，由北家胡")
case(id="R03", group="宣告與流程", title="胡過水：整組聽牌都不能胡", expectNoWin=True,
     note="南家聽 6、9 條，放過西家的 6 條 → 之後別人打 6 條或 9 條都不能胡；不會隨巡解除")
case(id="R04", group="宣告與流程", title="胡過水期間自摸也不能胡", expectNoWin=True,
     note="南家過水後自己摸到 9 條也不能自摸；打出聽牌組裡的牌（6、9 條）不解除")
case(id="R07", group="宣告與流程", title="打出非聽牌解除胡過水", expectNoWin=True,
     note="南家過水後打出一張不在聽牌組裡的牌（或加槓）才解除；解除後重新聽牌，別人再打就能胡")
case(id="R08", group="宣告與流程", title="碰過水", expectNoWin=True,
     note="放過碰某張牌後，到自己下一次輪到（摸牌或吃碰）前不能再碰同一種牌；下一巡自動解除")
case(id="R05", group="宣告與流程", title="胡 > 碰 > 吃", expectNoWin=True,
     note="西家打 5 筒：北家可吃、東家可碰、南家可胡，結果由南家胡")
case(id="R06", group="宣告與流程", title="流局", expectNoWin=True, note="牌牆剩 16 張無人胡：不付分，莊家連莊、連莊數 +1")


# ---------- 程式用的情境旗標 ----------
CONTEXT = {
    "X01": {"robKong": True}, "X03": {"kongDraw": True}, "X04": {"kongDraw": True},
    "X05": {"lastTile": True}, "X06": {"lastTile": True},
    "X09": {"heavenly": True}, "X10": {"earthly": True},
    "G01": {"flowerBonusTaken": True},
    "T06": {"miji": True}, "T07": {"tianting": True}, "T08": {"tianting": True, "miji": True},
}
for c in CASES:
    c["context"] = CONTEXT.get(c["id"], {})
    c["kind"] = "scoring" if c.get("concealed") else ("flowerBonus" if c.get("flowerBonus") and not c.get("winner") else "process")
    if c.get("flowerBonus") and c.get("winner") and not c.get("concealed"):
        c["kind"] = "process"

# ---------- 驗證與輸出 ----------
def meld_tiles(m):
    return parse(m[1])

out = []
for c in CASES:
    c.setdefault("roundWind", "E")
    c.setdefault("base", 30); c.setdefault("perTai", 10)
    if c.get("concealed"):
        conc = parse(c["concealed"])
        melds = c.get("melds", [])
        allt = conc + [t for m in melds for t in meld_tiles(m)]
        cnt = Counter(allt)
        assert max(cnt.values()) <= 4, (c["id"], cnt)
        n_sets = 5 - len(melds)
        assert len(conc) == 3 * n_sets + 2, (c["id"], len(conc))
        kind = is_win(conc, n_sets)
        assert kind, f"{c['id']} not a winning hand"
        assert c["winTile"] in conc, c["id"]
        assert len(conc) == 3 * n_sets + 2, (c["id"], len(conc))
        if "嚦咕" in c["title"]:
            assert kind == "lig", c["id"]
    d = pay(c) if (c.get("winner") or c.get("flowerBonus")) else {s: 0 for s in SEATS}
    c["expectedTotalTai"] = sum(t for _, t in c.get("tai", []))
    c["expectedDelta"] = d
    out.append(c)

import os
os.makedirs(os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures") + "", exist_ok=True)
json.dump({"version": 1, "defaults": {"roundWind": "E", "dealerSeat": "E", "base": 30, "perTai": 10,
           "notation": "數字+m/p/s；E S W N C F P = 東南西北中發白；f1-f8 = 春夏秋冬梅蘭竹菊"},
           "cases": [{**c, "tai": [{"name": n, "tai": t} for n, t in c.get("tai", [])],
                      "extraWins": [{"winner": e["winner"], "tai": [{"name": n, "tai": t} for n, t in e["tai"]]} for e in c.get("extraWins", [])]}
                     for c in out]},
          open(os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures") + "/scoring-cases.json", "w"), ensure_ascii=False, indent=2)

# Markdown 供規格書使用
def pretty(s):
    return (s.replace("m", "萬 ").replace("p", "筒 ").replace("s", "條 ")
            .replace("E", "東").replace("S", "南").replace("W", "西").replace("N", "北")
            .replace("C", "中").replace("F", "發").replace("P", "白")).strip()

MELD = {"chi": "吃", "pon": "碰", "minkan": "明槓", "ankan": "暗槓", "kakan": "加槓"}
rows = []
for c in out:
    if c.get("concealed"):
        hand = pretty(c["concealed"])
        if c.get("melds"):
            hand += "｜" + "、".join(f"{MELD[m[0]]} {pretty(m[1])}" for m in c["melds"])
        if c.get("flowers"):
            hand += "｜花 " + "".join(FLOWER_NAME[f] for f in c["flowers"])
        hand += f"｜胡 {pretty(c['winTile'])}"
    else:
        hand = "—"
    sit = []
    if c.get("winner"):
        sit.append(f"{SEAT_NAME[c['winner']]}家" + ("自摸" if c["winType"] == "self" else f"胡{SEAT_NAME[c['discarder']]}家"))
    if c.get("roundWind", "E") != "E": sit.append(f"{SEAT_NAME[c['roundWind']]}風圈")
    if c.get("dealerStreak"): sit.append(f"連莊 {c['dealerStreak']}")
    if c.get("leopard"): sit.append("豹子")
    tai = "、".join(f"{n} {t}" for n, t in c.get("tai", [])) or ("—" if not c.get("winner") else "0 台")
    if c.get("winner"):
        tai += f"（合計 {c['expectedTotalTai']}）"
    delta = "—" if not any(c["expectedDelta"].values()) else "　".join(f"{SEAT_NAME[s]} {v:+d}" for s, v in c["expectedDelta"].items() if v)
    rows.append(f"| {c['id']} | {c['title']} | {hand} | {'；'.join(sit) or '—'} | {tai} | {delta} | {c.get('note', '')} |")

md = "| 編號 | 案例 | 手牌 | 情境 | 應得台數 | 分數變化 | 說明 |\n| --- | --- | --- | --- | --- | --- | --- |\n" + "\n".join(rows)
open(os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures") + "/scoring-cases.md", "w").write(md)
print(len(out), "cases OK")

# ---------- 聽牌數檢查：標示獨聽的案例必須只聽 1 種牌，其餘必須聽 2 種以上 ----------
ALL = [f"{n}{s}" for s in "mps" for n in range(1, 10)] + list(HONORS)
ids = [c["id"] for c in out]
assert len(ids) == len(set(ids)), "duplicate ids"
for c in out:
    if not c.get("concealed"):
        continue
    conc = parse(c["concealed"]); pre = conc.copy(); pre.remove(c["winTile"])
    n_sets = 5 - len(c.get("melds", []))
    used = Counter(conc + [t for m in c.get("melds", []) for t in meld_tiles(m)])
    waits = [t for t in ALL if Counter(pre)[t] + (used[t] - Counter(conc)[t]) < 4 and is_win(pre + [t], n_sets)]
    names = [n for n, _ in c.get("tai", [])]
    skip = any(k in names for k in ("半求", "全求", "天胡", "地胡"))
    if "獨聽" in names:
        assert waits == [c["winTile"]], (c["id"], waits)
    elif not skip:
        assert len(waits) >= 2, (c["id"], waits)
print("wait checks OK;", len(out), "cases:", " ".join(ids))
