import { decompose, Decomposition, isLigu, isOpen, Meld, SetShape, waits } from './hand';
import {
  FLOWER_START, TileKind, Wind, flowerSeat, isDragon, isHonor, isWind, suitOf, tileName, windTile,
} from './tiles';

/** 台數表（規格書 3.6），房間可覆寫任何一項 */
export const DEFAULT_TAI = {
  menqing: 1, // 門清
  zimo: 1, // 自摸
  menqingZimo: 3, // 門清自摸
  roundWind: 1, // 圈風刻
  seatWind: 1, // 門風刻
  dragon: 1, // 三元牌刻（每組）
  seatFlower: 1, // 正花（每張）
  flowerKong: 2, // 花槓（每組）
  singleWait: 1, // 獨聽
  robKong: 1, // 搶槓
  kongDraw: 1, // 槓上開花
  lastDraw: 1, // 海底撈月
  lastDiscard: 1, // 河底撈魚
  halfBeg: 1, // 半求
  fullBeg: 2, // 全求
  pinghu: 2, // 平胡
  concealed3: 2, // 三暗刻
  pengpeng: 4, // 碰碰胡
  halfFlush: 4, // 混一色
  littleDragons: 4, // 小三元
  concealed4: 5, // 四暗刻
  fullFlush: 8, // 清一色
  bigDragons: 8, // 大三元
  littleWinds: 8, // 小四喜
  concealed5: 8, // 五暗刻
  ligu: 8, // 嚦咕嚦咕
  earthly: 16, // 地胡
  bigWinds: 16, // 大四喜
  allHonors: 16, // 字一色
  heavenly: 24, // 天胡
  miji: 4, // 咪幾：整桌前 8 張捨牌以內報聽且沒人吃碰槓，胡牌時計
  tianting: 8, // 天聽：莊家打出第一張牌就報聽，胡牌時計（不另計咪幾）
  dealer: 1, // 莊家（結算時計）
  streak: 2, // 每連莊一次（連 N 拉 N = 2N）
  flowerBonus: 8, // 八仙過海／七搶一（立即收分）
};
export type TaiTable = typeof DEFAULT_TAI;
export type TaiKey = keyof TaiTable;

export interface WinContext {
  /** 胡牌後的門前牌（含胡的那張），不含副露與花牌 */
  concealed: TileKind[];
  melds: Meld[];
  winTile: TileKind;
  selfDraw: boolean;
  seatWind: Wind;
  roundWind: Wind;
  /** 胡牌者手上的花牌（34–41） */
  flowers: TileKind[];
  /** 已因八仙過海／七搶一收過分：不再計正花與花槓 */
  flowerBonusTaken?: boolean;
  robKong?: boolean;
  kongDraw?: boolean;
  /** 牌牆最後一張：自摸為海底撈月、放槍為河底撈魚 */
  lastTile?: boolean;
  heavenly?: boolean;
  earthly?: boolean;
  /** 咪幾（報聽時整桌捨牌 8 張以內、沒人吃碰槓） */
  miji?: boolean;
  /** 天聽（莊家第一張牌就報聽） */
  tianting?: boolean;
}

export interface TaiItem {
  key: TaiKey;
  name: string;
  tai: number;
}

export interface ScoreResult {
  items: TaiItem[];
  total: number;
  /** 以哪種拆法計分；嚦咕嚦咕為 'ligu' */
  shape: 'standard' | 'ligu';
}

const NAMES: Record<TaiKey, string> = {
  menqing: '門清', zimo: '自摸', menqingZimo: '門清自摸', roundWind: '圈風刻', seatWind: '門風刻',
  dragon: '三元牌刻', seatFlower: '正花', flowerKong: '花槓', singleWait: '獨聽', robKong: '搶槓',
  kongDraw: '槓上開花', lastDraw: '海底撈月', lastDiscard: '河底撈魚', halfBeg: '半求', fullBeg: '全求',
  pinghu: '平胡', concealed3: '三暗刻', pengpeng: '碰碰胡', halfFlush: '混一色', littleDragons: '小三元',
  concealed4: '四暗刻', fullFlush: '清一色', bigDragons: '大三元', littleWinds: '小四喜', concealed5: '五暗刻',
  ligu: '嚦咕嚦咕', earthly: '地胡', bigWinds: '大四喜', allHonors: '字一色', heavenly: '天胡',
  dealer: '莊家', streak: '連莊', flowerBonus: '八仙過海', miji: '咪幾', tianting: '天聽',
};

export class NotAWinError extends Error {}

/**
 * 計算胡牌台數（不含莊家與連莊，這兩項依付款人不同，在結算時計）。
 * 嘗試每一種拆法與胡牌張的歸屬，取台數最高者。
 */
export function scoreHand(ctx: WinContext, table: TaiTable = DEFAULT_TAI): ScoreResult {
  const T = (key: TaiKey, suffix = '', count = 1): TaiItem[] =>
    Array.from({ length: count }, () => ({ key, name: NAMES[key] + (suffix ? ` ${suffix}` : ''), tai: table[key] }));
  const finish = (items: TaiItem[], shape: ScoreResult['shape']): ScoreResult => ({
    items, total: items.reduce((s, i) => s + i.tai, 0), shape,
  });

  if (ctx.concealed.filter((t) => t === ctx.winTile).length === 0) throw new NotAWinError('winTile not in hand');
  const setsNeeded = 5 - ctx.melds.length;
  const decomps = decompose(ctx.concealed, setsNeeded);
  const ligu = isLigu(ctx.concealed, ctx.melds.length);
  if (!decomps.length && !ligu) throw new NotAWinError('not a winning hand');

  if (ctx.heavenly) return finish(T('heavenly'), decomps.length ? 'standard' : 'ligu');

  // ---- 與拆法無關的項目 ----
  const common: TaiItem[] = [];
  const allTiles = [...ctx.concealed, ...ctx.melds.flatMap((m) => m.tiles)];
  const menqing = ctx.melds.every((m) => !isOpen(m));
  const openCount = ctx.melds.filter(isOpen).length;
  const beg = openCount === 5 && ctx.concealed.length === 2;

  const suits = new Set(allTiles.filter((t) => !isHonor(t)).map(suitOf));
  const hasHonor = allTiles.some(isHonor);
  if (suits.size === 0) common.push(...T('allHonors'));
  else if (suits.size === 1) common.push(...(hasHonor ? T('halfFlush') : T('fullFlush')));

  if (!ctx.flowerBonusTaken) {
    const fl = new Set(ctx.flowers);
    for (const start of [FLOWER_START, FLOWER_START + 4]) {
      if ([0, 1, 2, 3].every((i) => fl.has(start + i))) common.push(...T('flowerKong'));
    }
    for (const f of [...fl].sort((a, b) => a - b)) {
      if (flowerSeat(f) === ctx.seatWind) common.push(...T('seatFlower', tileName(f)));
    }
  }

  if (ctx.robKong) common.push(...T('robKong'));
  if (ctx.kongDraw) common.push(...T('kongDraw'));
  if (ctx.lastTile) common.push(...T(ctx.selfDraw ? 'lastDraw' : 'lastDiscard'));
  if (ctx.earthly) common.push(...T('earthly'));
  if (ctx.tianting) common.push(...T('tianting'));
  else if (ctx.miji) common.push(...T('miji'));
  if (beg) common.push(...T(ctx.selfDraw ? 'halfBeg' : 'fullBeg'));

  const preHand = [...ctx.concealed];
  preHand.splice(preHand.indexOf(ctx.winTile), 1);
  const single = !beg && waits(preHand, ctx.melds).length === 1;
  if (single) common.push(...T('singleWait'));

  const candidates: ScoreResult[] = [];

  // ---- 嚦咕嚦咕：七對加一刻，不計門清、暗刻及其他面子類台數 ----
  if (ligu) {
    const items = [...T('ligu'), ...(ctx.selfDraw ? T('zimo') : []), ...common];
    candidates.push(finish(items, 'ligu'));
  }

  // ---- 標準型 ----
  const meldSets: SetShape[] = ctx.melds.map((m) => ({
    kind: m.type === 'chi' ? 'seq' : 'tri',
    tile: Math.min(...m.tiles),
  }));
  const ankanCount = ctx.melds.filter((m) => m.type === 'ankan').length;

  for (const d of decomps) {
    for (const winIn of winPlacements(d, ctx.winTile, ctx.selfDraw)) {
      const items = [...common];
      if (menqing) items.push(...(ctx.selfDraw ? T('menqingZimo') : T('menqing')));
      else if (ctx.selfDraw) items.push(...T('zimo'));

      const sets = [...d.sets, ...meldSets];
      const tri = sets.filter((s) => s.kind === 'tri').map((s) => s.tile);

      // 風
      const windTri = tri.filter(isWind);
      if (windTri.length === 4) items.push(...T('bigWinds'));
      else if (windTri.length === 3 && isWind(d.pair)) items.push(...T('littleWinds'));
      else {
        if (windTri.includes(windTile(ctx.roundWind))) items.push(...T('roundWind'));
        if (windTri.includes(windTile(ctx.seatWind))) items.push(...T('seatWind'));
      }
      // 三元
      const dragonTri = tri.filter(isDragon).sort((a, b) => a - b);
      if (dragonTri.length === 3) items.push(...T('bigDragons'));
      else {
        if (dragonTri.length === 2 && isDragon(d.pair)) items.push(...T('littleDragons'));
        for (const t of dragonTri) items.push(...T('dragon', tileName(t)));
      }
      // 碰碰胡／平胡
      if (sets.every((s) => s.kind === 'tri')) items.push(...T('pengpeng'));
      if (
        sets.every((s) => s.kind === 'seq') && !hasHonor && ctx.flowers.length === 0 &&
        !ctx.selfDraw && !single
      ) items.push(...T('pinghu'));
      // 暗刻：門前刻子（放槍完成的那組除外）＋暗槓
      const concealedTri = d.sets.filter((s, i) => s.kind === 'tri' && i !== winIn).length + ankanCount;
      if (concealedTri >= 5) items.push(...T('concealed5'));
      else if (concealedTri === 4) items.push(...T('concealed4'));
      else if (concealedTri === 3) items.push(...T('concealed3'));

      candidates.push(finish(items, 'standard'));
    }
  }

  return candidates.reduce((best, c) => (c.total > best.total ? c : best));
}

/**
 * 放槍胡牌時，胡的那張可能落在眼或不同面子上；回傳「被放槍完成的面子」索引的所有可能。
 * -1 表示落在眼上或自摸（所有門前刻子都算暗刻）。
 */
function winPlacements(d: Decomposition, win: TileKind, selfDraw: boolean): number[] {
  if (selfDraw) return [-1];
  const idx: number[] = [];
  if (d.pair === win) idx.push(-1);
  d.sets.forEach((s, i) => {
    const has = s.kind === 'tri' ? s.tile === win : win >= s.tile && win <= s.tile + 2;
    if (has) idx.push(i);
  });
  return idx.length ? idx : [-1];
}
