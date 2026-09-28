/**
 * 向聽數：還差幾張能聽牌。聽牌 = 0，已胡 = -1。
 * 標準型需要 need 組面子 + 1 對眼（need = 5 − 副露數）；
 * 沒有副露時另外計算嚦咕嚦咕（七對加一刻），取較小值。
 */
import { PLAYABLE_KINDS, TileKind } from '../engine/tiles';

type Combo = [number, number, number]; // [面子, 搭子, 眼(0/1)]

// 以 8 進位數字當快取鍵（每種牌張數 0–7），比字串快很多；數牌與字牌分開快取
const memoSuit = new Map<number, Combo[]>();
const memoHonor = new Map<number, Combo[]>();

function blockOf(counts: number[], start: number, len: number, honor: boolean): Combo[] {
  let key = 0;
  for (let i = start; i < start + len; i++) key = key * 8 + counts[i];
  const memo = honor ? memoHonor : memoSuit;
  const hit = memo.get(key);
  if (hit) return hit;
  const res = analyzeBlock(counts.slice(start, start + len), honor);
  memo.set(key, res);
  return res;
}

function analyzeBlock(c: number[], honor: boolean): Combo[] {
  const found = new Set<string>();
  const cc = [...c];
  const dfs = (i: number, m: number, t: number, h: number) => {
    while (i < cc.length && cc[i] === 0) i++;
    if (i >= cc.length) {
      found.add(`${m},${t},${h}`);
      return;
    }
    if (cc[i] >= 3) { cc[i] -= 3; dfs(i, m + 1, t, h); cc[i] += 3; }
    if (!honor && i <= cc.length - 3 && cc[i + 1] > 0 && cc[i + 2] > 0) {
      cc[i]--; cc[i + 1]--; cc[i + 2]--; dfs(i, m + 1, t, h); cc[i]++; cc[i + 1]++; cc[i + 2]++;
    }
    if (cc[i] >= 2) {
      cc[i] -= 2;
      if (h === 0) dfs(i, m, t, 1);
      dfs(i, m, t + 1, h);
      cc[i] += 2;
    }
    if (!honor) {
      if (i + 1 < cc.length && cc[i + 1] > 0) { cc[i]--; cc[i + 1]--; dfs(i, m, t + 1, h); cc[i]++; cc[i + 1]++; }
      if (i + 2 < cc.length && cc[i + 2] > 0) { cc[i]--; cc[i + 2]--; dfs(i, m, t + 1, h); cc[i]++; cc[i + 2]++; }
    }
    cc[i]--; dfs(i, m, t, h); cc[i]++;
  };
  dfs(0, 0, 0, 0);
  // 只留下沒被支配的組合
  const all = [...found].map((s) => s.split(',').map(Number) as Combo);
  const res = all.filter((a) => !all.some((b) => b !== a && b[0] >= a[0] && b[1] >= a[1] && b[2] >= a[2] &&
    (b[0] > a[0] || b[1] > a[1] || b[2] > a[2])));
  return res;
}

function standardShanten(counts: number[], need: number): number {
  const blocks = [
    blockOf(counts, 0, 9, false),
    blockOf(counts, 9, 9, false),
    blockOf(counts, 18, 9, false),
    blockOf(counts, 27, 7, true),
  ];
  let best = 99;
  const walk = (bi: number, m: number, t: number, h: number) => {
    if (bi === blocks.length) {
      const mm = Math.min(m, need);
      const tt = Math.min(t, need - mm);
      best = Math.min(best, 2 * need - 2 * mm - tt - Math.min(h, 1));
      return;
    }
    for (const [bm, bt, bh] of blocks[bi]) {
      if (h + bh > 1) {
        // 第二個眼當搭子
        walk(bi + 1, m + bm, t + bt + 1, h);
      } else walk(bi + 1, m + bm, t + bt, h + bh);
    }
  };
  walk(0, 0, 0, 0);
  return best;
}

function liguShanten(counts: number[]): number {
  let pairs = 0;
  let triple = false;
  for (let k = 0; k < PLAYABLE_KINDS; k++) {
    if (counts[k] >= 2) pairs++;
    if (counts[k] >= 3) triple = true;
  }
  return 8 - Math.min(pairs, 8) + (triple ? 0 : 1) - 1;
}

export function shantenCounts(counts: number[], meldCount: number): number {
  const s = standardShanten(counts, 5 - meldCount);
  return meldCount === 0 ? Math.min(s, liguShanten(counts)) : s;
}

export function shanten(tiles: readonly TileKind[], meldCount: number): number {
  const c = new Array<number>(PLAYABLE_KINDS).fill(0);
  for (const t of tiles) c[t]++;
  return shantenCounts(c, meldCount);
}
