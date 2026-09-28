/**
 * 牌的編碼（規格書 6.3 節）
 *   0–8   一至九萬
 *   9–17  一至九筒
 *   18–26 一至九條
 *   27–33 東 南 西 北 中 發 白
 *   34–41 春 夏 秋 冬 梅 蘭 竹 菊（花牌）
 * 「牌種」指 0–41；一副牌 144 張，每張實體牌另以 0–143 編號（見 wall.ts）。
 */
export type TileKind = number;

export const MAN = 0;
export const PIN = 9;
export const SOU = 18;
export const EAST = 27;
export const SOUTH = 28;
export const WEST = 29;
export const NORTH = 30;
export const RED = 31; // 中
export const GREEN = 32; // 發
export const WHITE = 33; // 白
export const FLOWER_START = 34;
export const KIND_COUNT = 42;
export const PLAYABLE_KINDS = 34;

/** 座位／風：0 東、1 南、2 西、3 北 */
export type Wind = 0 | 1 | 2 | 3;
export const WINDS: readonly Wind[] = [0, 1, 2, 3];
export const WIND_NAMES = ['東', '南', '西', '北'] as const;

export const isSuited = (t: TileKind) => t < 27;
export const isHonor = (t: TileKind) => t >= 27 && t < 34;
export const isWind = (t: TileKind) => t >= EAST && t <= NORTH;
export const isDragon = (t: TileKind) => t >= RED && t <= WHITE;
export const isFlower = (t: TileKind) => t >= FLOWER_START && t < KIND_COUNT;
/** 0 萬、1 筒、2 條；字牌與花牌回傳 -1 */
export const suitOf = (t: TileKind) => (t < 27 ? Math.floor(t / 9) : -1);
/** 數牌點數 1–9；其他回傳 0 */
export const rankOf = (t: TileKind) => (t < 27 ? (t % 9) + 1 : 0);
export const windTile = (w: Wind): TileKind => EAST + w;

const NUMS = '一二三四五六七八九';
const HONOR_NAMES = ['東', '南', '西', '北', '中', '發', '白'];
const FLOWER_NAMES = ['春', '夏', '秋', '冬', '梅', '蘭', '竹', '菊'];
const SUIT_NAMES = ['萬', '筒', '條'];

export function tileName(t: TileKind): string {
  if (t < 27) return NUMS[t % 9] + SUIT_NAMES[suitOf(t)];
  if (t < 34) return HONOR_NAMES[t - 27];
  return FLOWER_NAMES[t - FLOWER_START];
}

/** 花牌對應的門風：春梅→東、夏蘭→南、秋竹→西、冬菊→北 */
export const flowerSeat = (f: TileKind): Wind => ((f - FLOWER_START) % 4) as Wind;

/**
 * 文字寫法（測試與除錯用）：
 *   數字 + m/p/s（萬筒條），例如 "123m55p"
 *   E S W N C F P = 東 南 西 北 中 發 白
 *   f1–f8 = 春夏秋冬梅蘭竹菊
 */
export function parseTiles(s: string): TileKind[] {
  const out: TileKind[] = [];
  let digits = '';
  const str = s.replace(/\s+/g, '');
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === 'f') {
      const n = Number(str[++i]);
      if (!(n >= 1 && n <= 8)) throw new Error(`bad flower in "${s}"`);
      out.push(FLOWER_START + n - 1);
    } else if (/[0-9]/.test(ch)) {
      digits += ch;
    } else if (ch === 'm' || ch === 'p' || ch === 's') {
      const base = ch === 'm' ? MAN : ch === 'p' ? PIN : SOU;
      for (const d of digits) {
        const n = Number(d);
        if (n < 1 || n > 9) throw new Error(`bad rank in "${s}"`);
        out.push(base + n - 1);
      }
      digits = '';
    } else {
      const idx = 'ESWNCFP'.indexOf(ch);
      if (idx < 0) throw new Error(`bad char "${ch}" in "${s}"`);
      out.push(EAST + idx);
    }
  }
  if (digits) throw new Error(`dangling digits in "${s}"`);
  return out;
}

export function toCounts(tiles: readonly TileKind[]): number[] {
  const c = new Array<number>(KIND_COUNT).fill(0);
  for (const t of tiles) c[t]++;
  return c;
}

export const sortTiles = (tiles: readonly TileKind[]) => [...tiles].sort((a, b) => a - b);
