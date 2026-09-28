import { PLAYABLE_KINDS, TileKind, toCounts } from './tiles';

export type MeldType = 'chi' | 'pon' | 'minkan' | 'ankan' | 'kakan';
/** 副露（含暗槓）。tiles 為組成的牌種，吃為三張順子、碰三張、槓四張。 */
export interface Meld {
  type: MeldType;
  tiles: TileKind[];
  /** 吃碰明槓時，牌來自哪個座位 */
  from?: number;
}

export const isKong = (m: Meld) => m.type === 'minkan' || m.type === 'ankan' || m.type === 'kakan';
export const isOpen = (m: Meld) => m.type !== 'ankan';

export type SetShape = { kind: 'seq' | 'tri'; tile: TileKind };
/** 門前牌的一種拆法：一對眼 + 若干組面子 */
export interface Decomposition {
  pair: TileKind;
  sets: SetShape[];
}

/** 把 counts 剛好拆成 n 組面子，列出所有拆法（去重）。 */
function allSets(c: number[], n: number, from = 0): SetShape[][] {
  if (n === 0) return c.every((v) => v === 0) ? [[]] : [];
  let t = from;
  while (t < PLAYABLE_KINDS && c[t] === 0) t++;
  if (t >= PLAYABLE_KINDS) return [];
  const results: SetShape[][] = [];
  if (c[t] >= 3) {
    c[t] -= 3;
    for (const rest of allSets(c, n - 1, t)) results.push([{ kind: 'tri', tile: t }, ...rest]);
    c[t] += 3;
  }
  if (t < 27 && t % 9 <= 6 && c[t + 1] > 0 && c[t + 2] > 0) {
    c[t]--; c[t + 1]--; c[t + 2]--;
    for (const rest of allSets(c, n - 1, t)) results.push([{ kind: 'seq', tile: t }, ...rest]);
    c[t]++; c[t + 1]++; c[t + 2]++;
  }
  return results;
}

/** 列出門前牌（不含副露）所有可胡的標準拆法。setsNeeded = 5 − 副露數。 */
export function decompose(concealed: readonly TileKind[], setsNeeded: number): Decomposition[] {
  if (concealed.length !== setsNeeded * 3 + 2) return [];
  const c = toCounts(concealed);
  const out: Decomposition[] = [];
  for (let p = 0; p < PLAYABLE_KINDS; p++) {
    if (c[p] < 2) continue;
    c[p] -= 2;
    for (const sets of allSets(c, setsNeeded)) out.push({ pair: p, sets });
    c[p] += 2;
  }
  return out;
}

/** 嚦咕嚦咕：門前 17 張 = 七組對子 + 一組刻子（同種牌不能當兩對）。 */
export function isLigu(concealed: readonly TileKind[], meldCount: number): boolean {
  if (meldCount !== 0 || concealed.length !== 17) return false;
  const c = toCounts(concealed);
  let pairs = 0;
  let triples = 0;
  for (let t = 0; t < PLAYABLE_KINDS; t++) {
    if (c[t] === 0) continue;
    if (c[t] === 2) pairs++;
    else if (c[t] === 3) triples++;
    else return false;
  }
  return pairs === 7 && triples === 1;
}

export function isWinningShape(concealed: readonly TileKind[], meldCount: number): boolean {
  return decompose(concealed, 5 - meldCount).length > 0 || isLigu(concealed, meldCount);
}

/**
 * 聽哪些牌：preHand 為胡牌前的門前牌（3n+1 張）。
 * 自己手上與副露已用滿 4 張的牌種不算。
 */
export function waits(preHand: readonly TileKind[], melds: readonly Meld[]): TileKind[] {
  const used = toCounts([...preHand, ...melds.flatMap((m) => m.tiles)]);
  const res: TileKind[] = [];
  for (let t = 0; t < PLAYABLE_KINDS; t++) {
    if (used[t] >= 4) continue;
    if (isWinningShape([...preHand, t], melds.length)) res.push(t);
  }
  return res;
}
