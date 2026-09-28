import { GameRules, DEFAULT_RULES, GameState, TileId, kindOf, newGame, apply, turnOptions } from '../src/engine/game';
import { parseTiles, TileKind, Wind } from '../src/engine/tiles';

/**
 * 依指定手牌堆出一副牌牆：莊家（東、座位 0）17 張，其餘 16 張，
 * draws 依序為之後的正常摸牌，back 為牌尾（補花、補槓）由尾往前的順序。
 */
export function stackWall(opts: { E: string; S: string; W: string; N: string; draws?: string; back?: string }): TileId[] {
  const used = new Array<number>(42).fill(0);
  const take = (k: TileKind): TileId => {
    const n = used[k]++;
    if (k >= 34) {
      if (n > 0) throw new Error('flower used twice');
      return 136 + (k - 34);
    }
    if (n >= 4) throw new Error(`kind ${k} used more than 4 times`);
    return k * 4 + n;
  };
  const e = parseTiles(opts.E).map(take);
  const s = parseTiles(opts.S).map(take);
  const w = parseTiles(opts.W).map(take);
  const n = parseTiles(opts.N).map(take);
  if (e.length !== 17 || s.length !== 16 || w.length !== 16 || n.length !== 16) {
    throw new Error(`bad hand sizes ${e.length}/${s.length}/${w.length}/${n.length}`);
  }
  const draws = parseTiles(opts.draws ?? '').map(take);
  const back = parseTiles(opts.back ?? '').map(take);
  const rest: TileId[] = [];
  const flowersLeft: TileId[] = [];
  for (let k = 0; k < 42; k++) {
    const max = k >= 34 ? 1 : 4;
    while (used[k] < max) (k >= 34 ? flowersLeft : rest).push(take(k));
  }
  // 沒指定的花放在牌牆正中間，避免測試前段摸到
  const mid = Math.floor(rest.length / 2);
  const filler = [...rest.slice(0, mid), ...flowersLeft, ...rest.slice(mid)];
  // 配牌順序：每人每次 4 張、輪 4 次，最後莊家跳 1 張
  const deal: TileId[] = [];
  for (let r = 0; r < 4; r++) for (const h of [e, s, w, n]) deal.push(...h.slice(r * 4, r * 4 + 4));
  const wall = [...deal, e[16], ...draws, ...filler, ...[...back].reverse()];
  if (wall.length !== 144 || new Set(wall).size !== 144) throw new Error('wall must be 144 unique tiles');
  return wall;
}

/** 預設骰子 1+2+2=5 點：從莊家數到第 5 家又回到莊家，所以開門在莊家、莊家是東 */
export function stackedGame(opts: Parameters<typeof stackWall>[0], rules: Partial<GameRules> = {}, dice?: [number, number, number]) {
  return settle(newGame({ ...DEFAULT_RULES, ...rules }, 1, { wall: stackWall(opts), dice: dice ?? [1, 2, 2] }));
}

/** 把補花一步一步推完（牌桌控制器平常會隔一段時間自動推進） */
export function settle(s: GameState): GameState {
  for (let i = 0; i < 100 && s.phase.kind === 'flowers'; i++) apply(s, { type: 'flowerStep' });
  return s;
}

export const findTile = (s: GameState, seat: Wind, kindStr: string): TileId => {
  const k = parseTiles(kindStr)[0];
  const t = s.players[seat].hand.find((x) => kindOf(x) === k);
  if (t === undefined) throw new Error(`seat ${seat} has no ${kindStr}`);
  return t;
};

export const discard = (s: GameState, seat: Wind, kindStr: string) => {
  apply(s, { type: 'discard', seat, tile: findTile(s, seat, kindStr) });
  settle(s);
};

/** 目前等待宣告的每一家都送 pass */
export function passAll(s: GameState) {
  if (s.phase.kind !== 'claims') return void settle(s);
  for (const seat of Object.keys(s.phase.options).map(Number) as Wind[]) {
    if (s.phase.kind === 'claims' && !s.phase.responses[seat]) apply(s, { type: 'claim', seat, choice: 'pass' });
  }
  settle(s);
}

/** 檢查牌數守恆：144 張都在牌牆、手牌、副露、花、捨牌中各出現一次 */
export function assertConservation(s: GameState) {
  const all = [
    ...s.wall.slice(s.wallHead, s.wallTail),
    ...s.players.flatMap((p) => [...p.hand, ...p.melds.flatMap((m) => m.tiles), ...p.flowers, ...p.discards]),
  ];
  // 放槍胡的那張不在任何人手上，一炮多響時多位胡牌者共用同一張
  if (s.phase.kind === 'handOver' || s.phase.kind === 'matchOver') {
    const won = new Set(s.phase.result.wins.filter((w) => w.from !== undefined).map((w) => w.winTile));
    all.push(...won);
  }
  if (all.length !== 144 || new Set(all).size !== 144) {
    throw new Error(`tile conservation broken: ${all.length} tiles, ${new Set(all).size} unique`);
  }
}

export { turnOptions };
