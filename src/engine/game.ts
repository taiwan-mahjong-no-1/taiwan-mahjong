/**
 * 對局狀態機（規格書 3.2–3.11）。
 * 純資料、可序列化：房主把整個 GameState 存成快照即可在重開分頁後恢復。
 * 計時、AI、網路都不在這裡；逾時由外部送出對應動作（出牌逾時打出剛摸的牌、宣告逾時送 pass）。
 */
import { isWinningShape, Meld, MeldType, waits } from './hand';
import { createRng, rollDie, shuffle } from './rng';
import { NotAWinError, ScoreResult, scoreHand } from './scoring';
import {
  addDeltas, dealerTai, DEFAULT_SCORE_RULES, Deltas, HandMoney, ScoreRules, settleFlowerBonus, settleWin, zeroDeltas,
} from './settlement';
import { isFlower, TileKind, Wind } from './tiles';
import { breakSeatOf } from './wall';

/** 實體牌 0–143：0–135 為 34 種牌各 4 張（id = 牌種×4 + 第幾張），136–143 為 8 張花 */
export type TileId = number;
export const kindOf = (id: TileId): TileKind => (id < 136 ? Math.floor(id / 4) : 34 + (id - 136));
export const kindsOf = (ids: readonly TileId[]) => ids.map(kindOf);

export interface GameRules {
  score: ScoreRules;
  /** false = 截胡（逆時針最近者胡）；true = 一炮多響 */
  multiWin: boolean;
  /** 牌牆剩幾張時流局 */
  reserveTiles: number;
  /** 打幾圈：1 或 4（一將） */
  rounds: 1 | 4;
}

export const DEFAULT_RULES: GameRules = {
  score: DEFAULT_SCORE_RULES,
  multiWin: false,
  reserveTiles: 16,
  rounds: 1,
};

export interface MeldState {
  type: MeldType;
  tiles: TileId[];
  /** 吃碰明槓的牌來自哪家 */
  from?: Wind;
}

export interface PlayerState {
  hand: TileId[];
  melds: MeldState[];
  flowers: TileId[];
  discards: TileId[];
  /**
   * 胡過水（規格書 3.11）：放過胡牌時聽的整組牌（含放過的那張）。
   * 這些牌別人打出、自己摸到都不能胡；打出一張不在這組裡的牌（非聽牌）或加槓才解除，不會隨巡解除。
   */
  passedWin: TileKind[];
  /** 碰過水：放過碰的牌種，自己下一次輪到（摸牌或吃碰）前不能再碰這種牌 */
  passedPon?: TileKind[];
  /** 本局摸牌次數（不含補花、補槓） */
  drawCount: number;
  /** 已因八仙過海／七搶一收過分 */
  flowerBonusTaken: boolean;
  /** 已報聽：之後自動摸打、見胡必胡，不能再吃碰槓 */
  declared: boolean;
  /** 報聽時打出的那張牌 */
  declareTile: TileId | null;
  /** 咪幾：整桌前 8 張捨牌以內（含）報聽，且報聽前沒有人吃碰槓（4 台） */
  miji: boolean;
  /** 天聽：莊家打出本局第一張牌就報聽（8 台，不另計咪幾） */
  tianting?: boolean;
}

export type ClaimChoice = 'hu' | 'kong' | 'pon' | 'chi' | 'pass';
export interface ClaimOptions {
  hu: boolean;
  kong: boolean;
  pon: boolean;
  /** 可吃的組合（手上要拿出的兩張牌種） */
  chi: [TileKind, TileKind][];
}

export interface ClaimResponse {
  choice: ClaimChoice;
  chi?: [TileKind, TileKind];
}

export type Phase =
  | {
      kind: 'turn'; seat: Wind; drew: TileId | null; kongDraw: boolean;
      /** 吃碰後這一手不能打的牌種（吃進的那張、同一搭另一端的牌；碰上家的那張） */
      noDiscard?: TileKind[];
      /** 碰上家後這一手不能加槓的牌種（要等下一輪） */
      noKakan?: TileKind[];
      /** 大明槓（槓別人打的牌）後補的牌不能自摸（規格書 3.3） */
      noTsumo?: boolean;
    }
  | {
      /**
       * 補花（規格書 3.2）：一步一步來，讓畫面看得到原本的牌、亮花、補牌。
       * 由牌桌控制器隔一小段時間送出 flowerStep 推進，不是玩家的選擇。
       */
      kind: 'flowers'; seat: Wind;
      /** 開局補花：idx 是這一輪從莊家數起第幾家 */
      opening: boolean; idx: number;
      /** 打牌中補花：補完後回到出牌時的狀態 */
      then?: { kongDraw: boolean; noTsumo?: boolean };
    }
  | {
      kind: 'claims';
      from: Wind;
      tile: TileId;
      /** true = 加槓後的搶槓時機，只能胡或過 */
      robKong: boolean;
      /** 這張是牌牆見底後的最後一張捨牌（河底撈魚） */
      lastDiscard: boolean;
      options: Partial<Record<Wind, ClaimOptions>>;
      responses: Partial<Record<Wind, ClaimResponse>>;
    }
  | { kind: 'handOver'; result: HandResult }
  | { kind: 'matchOver'; result: HandResult };

export interface WinRecord {
  seat: Wind;
  from?: Wind;
  winTile: TileId;
  score: ScoreResult;
  deltas: Deltas;
  /** 這一把適用的莊家台（莊家 1 + 連莊 2N）；莊家沒參與為 0 */
  dealerTai: number;
  /** 閒家自摸：莊家台只由莊家付 */
  dealerOnly: boolean;
}

export interface FlowerBonusRecord {
  kind: 'eightImmortals' | 'sevenRobOne';
  to: Wind;
  from?: Wind;
  deltas: Deltas;
}

export interface HandResult {
  type: 'win' | 'draw';
  wins: WinRecord[];
  flowerBonus?: FlowerBonusRecord;
  /** 本局所有分數變化（含花牌收分） */
  deltas: Deltas;
  dealerContinues: boolean;
}

export type GameEvent =
  | { t: 'handStart'; handNo: number }
  | { t: 'draw'; seat: Wind; supplement: boolean }
  | { t: 'flower'; seat: Wind; tile: TileId }
  | { t: 'discard'; seat: Wind; tile: TileId }
  | { t: 'meld'; seat: Wind; meld: MeldState }
  | { t: 'flowerBonus'; record: FlowerBonusRecord }
  | { t: 'handOver'; result: HandResult };

export interface GameState {
  rules: GameRules;
  seed: number;
  handNo: number;
  roundWind: Wind;
  /** 已打完幾圈 */
  roundsDone: number;
  dealer: Wind;
  dealerStreak: number;
  scores: Deltas;
  dice: [number, number, number];
  leopard: boolean;
  /** 開門那家（骰子決定）：本局門風與正花以這家為東、1 花 */
  breakSeat: Wind;
  wall: TileId[];
  wallHead: number;
  wallTail: number;
  players: PlayerState[];
  phase: Phase;
  flowerBonusDone: boolean;
  flowerBonus?: FlowerBonusRecord;
  /** 本局已有人吃碰槓（用於天胡、地胡） */
  anyCall: boolean;
  /** 本局已有人打出牌 */
  anyDiscard: boolean;
  /** 本局整桌已打出幾張牌（咪幾判定用） */
  discardCount: number;
  /** 遞增的事件序號，網路同步用 */
  seq: number;
  events: GameEvent[];
  /** 計分總表：這一將（或一圈）每一局的分數變化，打完才結算 */
  history: HandRecord[];
}

/** 計分總表的一列 */
export interface HandRecord {
  handNo: number;
  roundWind: Wind;
  dealer: Wind;
  dealerStreak: number;
  leopard: boolean;
  type: 'win' | 'draw';
  wins: { seat: Wind; from?: Wind; tai: number; dealerTai?: number; dealerOnly?: boolean }[];
  flowerBonus?: { kind: FlowerBonusRecord['kind']; to: Wind; from?: Wind };
  deltas: Deltas;
  /** 這一局結束後的累計總分 */
  totals: Deltas;
}

export type Action =
  | { type: 'discard'; seat: Wind; tile: TileId; /** 打這張報聽 */ declare?: boolean }
  | { type: 'tsumo'; seat: Wind }
  | { type: 'ankan'; seat: Wind; kind: TileKind }
  | { type: 'kakan'; seat: Wind; kind: TileKind }
  | { type: 'claim'; seat: Wind; choice: ClaimChoice; chi?: [TileKind, TileKind] }
  | { type: 'nextHand' }
  /** 補花推進一步（由牌桌控制器送出） */
  | { type: 'flowerStep' };

export class IllegalAction extends Error {}

const next = (s: Wind, n = 1) => ((s + n) % 4) as Wind;
const SEATS: Wind[] = [0, 1, 2, 3];
export const remaining = (s: GameState) => s.wallTail - s.wallHead;
/** 門風：開門那家為東，下家為南，依此類推（舊存檔沒有 breakSeat 時以莊家為東） */
export const seatWindOf = (s: GameState, seat: Wind) => ((seat - (s.breakSeat ?? s.dealer) + 4) % 4) as Wind;

// ---------------------------------------------------------------- 開局

export interface HandLayout {
  /** 完整牌牆順序（144 張實體牌），測試用；省略則依種子洗牌 */
  wall?: TileId[];
  dice?: [number, number, number];
}

export function newGame(rules: GameRules, seed: number, layout?: HandLayout): GameState {
  const s: GameState = {
    rules, seed, handNo: 0, roundWind: 0, roundsDone: 0, dealer: 0, dealerStreak: 0,
    scores: zeroDeltas(), history: [], dice: [1, 1, 1], leopard: false, breakSeat: 0, wall: [], wallHead: 0, wallTail: 0,
    players: [], phase: { kind: 'turn', seat: 0, drew: null, kongDraw: false },
    flowerBonusDone: false, anyCall: false, anyDiscard: false, discardCount: 0, seq: 0, events: [],
  };
  startHand(s, layout);
  return s;
}

function startHand(s: GameState, layout?: HandLayout) {
  const rng = createRng((s.seed ^ Math.imul(s.handNo + 1, 0x9e3779b1)) >>> 0);
  s.wall = layout?.wall ? [...layout.wall] : shuffle(Array.from({ length: 144 }, (_, i) => i), rng);
  s.dice = layout?.dice ?? [rollDie(rng), rollDie(rng), rollDie(rng)];
  s.leopard = s.dice[0] === s.dice[1] && s.dice[1] === s.dice[2];
  s.breakSeat = breakSeatOf(s.dealer, s.dice);
  // wall 陣列即抓牌順序（見 wall.ts），牌牆實際位置由 breakSeat 與骰子點數推得
  s.wallHead = 0;
  s.wallTail = 144;
  s.flowerBonusDone = false;
  s.flowerBonus = undefined;
  s.anyCall = false;
  s.anyDiscard = false;
  s.discardCount = 0;
  s.events = [];
  s.players = SEATS.map(() => ({
    hand: [], melds: [], flowers: [], discards: [], passedWin: [], passedPon: [], drawCount: 0, flowerBonusTaken: false,
    declared: false, declareTile: null, miji: false, tianting: false,
  }));
  emit(s, { t: 'handStart', handNo: s.handNo });
  // 配牌：從莊家起每人每次抓 4 張，輪 4 次各 16 張，最後莊家再跳 1 張共 17 張
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < 4; i++) {
      const seat = next(s.dealer, i);
      s.players[seat].hand.push(...s.wall.slice(s.wallHead, s.wallHead + 4));
      s.wallHead += 4;
    }
  }
  s.players[s.dealer].hand.push(s.wall[s.wallHead++]);
  sortHands(s);
  // 開局補花（規格書 3.2）：一輪一輪補。每一輪從莊家起，各家把手上的花全部亮出、從牌尾補同樣張數；
  // 補上來的若又是花，要等這一輪其他人都補完，下一輪才能再補。直到四家手上都沒有花。
  // 先停在配好的原始牌，由 flowerStep 一家一家補
  nextOpeningFlowers(s, -1);
}

const hasFlower = (p: PlayerState) => p.hand.some((t) => isFlower(kindOf(t)));

/** 開局補花：從這一輪第 after+1 家找下一個有花的人；這一輪都沒有就開新的一輪；都沒花就開始打牌 */
function nextOpeningFlowers(s: GameState, after: number) {
  for (let i = after + 1; i < 4; i++) {
    const seat = next(s.dealer, i);
    if (hasFlower(s.players[seat])) {
      s.phase = { kind: 'flowers', seat, opening: true, idx: i };
      return;
    }
  }
  for (let i = 0; i < 4; i++) {
    const seat = next(s.dealer, i);
    if (hasFlower(s.players[seat])) {
      s.phase = { kind: 'flowers', seat, opening: true, idx: i };
      return;
    }
  }
  s.phase = { kind: 'turn', seat: s.dealer, drew: null, kongDraw: false };
}

/** 補花一步：這一家把手上的花全部亮出、從牌尾補同樣張數 */
function doFlowerStep(s: GameState) {
  const ph = s.phase;
  if (ph.kind !== 'flowers') throw new IllegalAction('no flowers to replace');
  const p = s.players[ph.seat];
  const flowers = p.hand.filter((t) => isFlower(kindOf(t)));
  for (const f of flowers) {
    p.hand.splice(p.hand.indexOf(f), 1);
    p.flowers.push(f);
    emit(s, { t: 'flower', seat: ph.seat, tile: f });
    checkFlowerBonus(s);
  }
  for (let n = 0; n < flowers.length; n++) {
    if (remaining(s) <= 0) return finishDraw(s);
    p.hand.push(s.wall[--s.wallTail]);
    emit(s, { t: 'draw', seat: ph.seat, supplement: true });
  }
  if (ph.opening) {
    // 開局：補到的花留到下一輪；手牌照順序排好（新補的牌也排進去）
    p.hand.sort((a, b) => a - b);
    return nextOpeningFlowers(s, ph.idx);
  }
  // 打牌中：補到的還是花就再補一步，否則輪到他出牌
  if (hasFlower(p)) return;
  s.phase = { kind: 'turn', seat: ph.seat, drew: p.hand[p.hand.length - 1], ...ph.then! };
}

function sortHands(s: GameState) {
  for (const p of s.players) p.hand.sort((a, b) => a - b);
}

function emit(s: GameState, e: GameEvent) {
  s.seq++;
  s.events.push(e);
}

/** 8 張花全部出現時判斷八仙過海或七搶一（規格書 3.10） */
function checkFlowerBonus(s: GameState) {
  if (s.flowerBonusDone) return;
  const counts = s.players.map((p) => p.flowers.length);
  if (counts.reduce((a, b) => a + b, 0) < 8) return;
  s.flowerBonusDone = true;
  const money = handMoney(s);
  const eight = counts.findIndex((c) => c === 8);
  let record: FlowerBonusRecord | undefined;
  if (eight >= 0) {
    const to = eight as Wind;
    record = { kind: 'eightImmortals', to, deltas: settleFlowerBonus('eightImmortals', to, undefined, s.rules.score, money) };
  } else {
    const holders = counts.map((c, i) => [c, i] as const).filter(([c]) => c > 0);
    if (holders.length === 2) {
      const seven = holders.find(([c]) => c === 7);
      const one = holders.find(([c]) => c === 1);
      if (seven && one) {
        const to = seven[1] as Wind;
        const from = one[1] as Wind;
        record = { kind: 'sevenRobOne', to, from, deltas: settleFlowerBonus('sevenRobOne', to, from, s.rules.score, money) };
      }
    }
  }
  if (!record) return;
  s.flowerBonus = record;
  s.players[record.to].flowerBonusTaken = true;
  s.scores = addDeltas(s.scores, record.deltas);
  emit(s, { t: 'flowerBonus', record });
}

const handMoney = (s: GameState): HandMoney => ({ dealer: s.dealer, dealerStreak: s.dealerStreak, leopard: s.leopard });

// ---------------------------------------------------------------- 可執行的動作

export interface TurnOptions {
  canTsumo: boolean;
  /** 可以報聽（還沒報聽過；實際能聽哪幾張由畫面計算） */
  canDeclare: boolean;
  /** 已報聽：只能自摸或打出剛摸的牌 */
  declared: boolean;
  /** 現在報聽可以拿到的台：天聽、咪幾或沒有 */
  tingBonus: 'tianting' | 'miji' | null;
  ankan: TileKind[];
  kakan: TileKind[];
  /** 吃碰後這一手不能打的牌種（規格書 3.3） */
  noDiscard: TileKind[];
}

/**
 * 吃牌後禁打（規格書 3.3）：不能馬上打出吃進的那張，也不能打出同一搭另一端的牌。
 * 例：手上二三四萬吃上家的一萬（用二三萬）→ 一萬、四萬這一手都不能打。
 * 吃中間那張（例：一三萬吃二萬）只禁打二萬。
 */
export function chiForbidden(claimed: TileKind, pair: [TileKind, TileKind]): TileKind[] {
  const [a, b] = [...pair].sort((x, y) => x - y);
  const r = claimed % 9;
  const out = [claimed];
  if (a === claimed + 1 && b === claimed + 2 && r + 3 <= 8) out.push(claimed + 3);
  if (a === claimed - 2 && b === claimed - 1 && r - 3 >= 0) out.push(claimed - 3);
  return out;
}

/** 這一手實際不能打的牌種；如果手上全都是禁打的牌就不限制 */
function effectiveNoDiscard(s: GameState, seat: Wind): TileKind[] {
  const ph = s.phase;
  if (ph.kind !== 'turn' || ph.seat !== seat || !ph.noDiscard?.length) return [];
  const kinds = kindsOf(s.players[seat].hand);
  return kinds.every((k) => ph.noDiscard!.includes(k)) ? [] : ph.noDiscard;
}

export function turnOptions(s: GameState, seat: Wind): TurnOptions | null {
  const ph = s.phase;
  if (ph.kind !== 'turn' || ph.seat !== seat) return null;
  const p = s.players[seat];
  const kinds = kindsOf(p.hand);
  const counts = new Map<TileKind, number>();
  for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  const firstDealerTurn = seat === s.dealer && !s.anyDiscard && !s.anyCall && p.drawCount === 0;
  const canDraw = remaining(s) > 0 && !p.declared;
  return {
    // 胡過水期間，摸到原本聽的牌也不能自摸
    canTsumo: !ph.noTsumo && (ph.drew !== null || firstDealerTurn) && isWinningShape(kinds, p.melds.length)
      && !(ph.drew !== null && p.passedWin.includes(kindOf(ph.drew))),
    // 公開報聽只在拿得到咪幾或天聽時（規格書 3.12）；沒台的聽牌改用只有自己知道的自動摸打
    canDeclare: !p.declared && tingBonusNow(s, seat) !== null,
    declared: p.declared,
    tingBonus: p.declared ? null : tingBonusNow(s, seat),
    ankan: canDraw ? [...counts].filter(([, c]) => c === 4).map(([k]) => k) : [],
    kakan: canDraw
      ? p.melds.filter((m) => m.type === 'pon' && kinds.includes(kindOf(m.tiles[0])))
        .map((m) => kindOf(m.tiles[0]))
        // 碰上家的牌：這一手不能馬上加槓，下一輪才能補槓
        .filter((k) => !(ph.noKakan ?? []).includes(k))
      : [],
    noDiscard: effectiveNoDiscard(s, seat),
  };
}

/** 這一張打出去若報聽，能拿到天聽或咪幾嗎（規格書 3.12） */
function tingBonusNow(s: GameState, seat: Wind): 'tianting' | 'miji' | null {
  if (s.anyCall) return null;
  const n = s.discardCount ?? 0;
  if (n === 0 && seat === s.dealer) return 'tianting';
  return n < 8 ? 'miji' : null;
}

function claimOptionsFor(s: GameState, seat: Wind, from: Wind, tile: TileId, robKong: boolean, last: boolean): ClaimOptions | null {
  const p = s.players[seat];
  const k = kindOf(tile);
  const kinds = kindsOf(p.hand);
  const hu = !p.passedWin.includes(k) && isWinningShape([...kinds, k], p.melds.length);
  // 已報聽的人只能胡
  if (robKong || last || p.declared) return hu ? { hu, kong: false, pon: false, chi: [] } : null;
  const count = kinds.filter((x) => x === k).length;
  const canDraw = remaining(s) > 0;
  const chi: [TileKind, TileKind][] = [];
  if (seat === next(from) && k < 27) {
    const r = k % 9;
    const has = (x: number) => kinds.includes(x);
    if (r >= 2 && has(k - 2) && has(k - 1)) chi.push([k - 2, k - 1]);
    if (r >= 1 && r <= 7 && has(k - 1) && has(k + 1)) chi.push([k - 1, k + 1]);
    if (r <= 6 && has(k + 1) && has(k + 2)) chi.push([k + 1, k + 2]);
  }
  // 上家打出的牌不能直接明槓（可以碰，下一輪再補槓）
  const fromUpper = seat === next(from);
  const o: ClaimOptions = { hu, kong: count >= 3 && canDraw && !fromUpper, pon: count >= 2 && !(p.passedPon ?? []).includes(k), chi };
  return o.hu || o.kong || o.pon || o.chi.length ? o : null;
}

// ---------------------------------------------------------------- 套用動作

export function apply(s: GameState, a: Action): void {
  switch (a.type) {
    case 'discard': return doDiscard(s, a.seat, a.tile, !!a.declare);
    case 'tsumo': return doTsumo(s, a.seat);
    case 'ankan': return doAnkan(s, a.seat, a.kind);
    case 'kakan': return doKakan(s, a.seat, a.kind);
    case 'claim': return doClaim(s, a.seat, { choice: a.choice, chi: a.chi });
    case 'nextHand': return doNextHand(s);
    case 'flowerStep': return doFlowerStep(s);
  }
}

function requireTurn(s: GameState, seat: Wind) {
  if (s.phase.kind !== 'turn' || s.phase.seat !== seat) throw new IllegalAction('not your turn');
  return s.phase;
}

function doDiscard(s: GameState, seat: Wind, tile: TileId, declare = false) {
  const ph = requireTurn(s, seat);
  const p = s.players[seat];
  const idx = p.hand.indexOf(tile);
  if (idx < 0) throw new IllegalAction('tile not in hand');
  if (effectiveNoDiscard(s, seat).includes(kindOf(tile))) throw new IllegalAction('cannot discard this tile right after chi / pon');
  // 報聽後手牌固定，只能打出剛摸的牌
  if (p.declared && ph.drew !== null && tile !== ph.drew) throw new IllegalAction('declared: must discard drawn tile');
  if (declare) {
    if (p.declared) throw new IllegalAction('already declared');
    if (!tingBonusNow(s, seat)) throw new IllegalAction('declare only for miji / tianting');
    const rest = kindsOf(p.hand.filter((t) => t !== tile));
    const melds = p.melds.map((m) => ({ type: m.type, tiles: kindsOf(m.tiles) }));
    if (!waits(rest, melds).length) throw new IllegalAction('not tenpai after this discard');
  }
  const bonus = declare ? tingBonusNow(s, seat) : null;
  p.hand.splice(idx, 1);
  p.discards.push(tile);
  // 胡過水：打出不在原本聽牌組裡的牌（非聽牌）才解除
  if (p.passedWin.length && !p.passedWin.includes(kindOf(tile))) p.passedWin = [];
  s.anyDiscard = true;
  s.discardCount = (s.discardCount ?? 0) + 1;
  if (declare) {
    p.declared = true;
    p.declareTile = tile;
    p.tianting = bonus === 'tianting';
    p.miji = bonus === 'miji';
  }
  emit(s, { t: 'discard', seat, tile });
  openClaims(s, seat, tile, false);
}

/** 打出牌或加槓後，詢問其他三家；沒人能宣告就直接進行下一步 */
function openClaims(s: GameState, from: Wind, tile: TileId, robKong: boolean) {
  const last = !robKong && remaining(s) <= s.rules.reserveTiles;
  const options: Partial<Record<Wind, ClaimOptions>> = {};
  for (const seat of SEATS) {
    if (seat === from) continue;
    const o = claimOptionsFor(s, seat, from, tile, robKong, last);
    if (o) options[seat] = o;
  }
  s.phase = { kind: 'claims', from, tile, robKong, lastDiscard: last, options, responses: {} };
  if (Object.keys(options).length === 0) resolveClaims(s);
}

function doClaim(s: GameState, seat: Wind, r: ClaimResponse) {
  const ph = s.phase;
  if (ph.kind !== 'claims') throw new IllegalAction('no claim window');
  const o = ph.options[seat];
  if (!o) throw new IllegalAction('no options for this seat');
  if (ph.responses[seat]) throw new IllegalAction('already responded');
  const ok =
    r.choice === 'pass' ||
    (r.choice === 'hu' && o.hu) ||
    (r.choice === 'kong' && o.kong) ||
    (r.choice === 'pon' && o.pon) ||
    (r.choice === 'chi' && !!r.chi && o.chi.some(([a, b]) => a === r.chi![0] && b === r.chi![1]));
  if (!ok) throw new IllegalAction(`illegal claim ${r.choice}`);
  ph.responses[seat] = r;
  if (claimsDecided(s)) resolveClaims(s);
}

const CLAIM_RANK: Record<ClaimChoice, number> = { hu: 3, kong: 2, pon: 2, chi: 1, pass: 0 };
const bestOption = (o: ClaimOptions) => (o.hu ? 3 : o.kong || o.pon ? 2 : o.chi.length ? 1 : 0);

/**
 * 宣告結果是否已經確定（規格書 3.3）：優先順序最高的人選完，其他人不用再等。
 * - 還沒回應的人，他能做的最好選擇如果比不過目前已選的，就不用等他。
 * - 胡：截胡時，比已選胡的人更靠近打牌者（逆時針先輪到）才需要等；一炮多響時每個能胡的人都要等。
 */
function claimsDecided(s: GameState): boolean {
  const ph = s.phase;
  if (ph.kind !== 'claims') return false;
  const seats = (Object.keys(ph.options) as unknown as string[]).map(Number) as Wind[];
  const pending = seats.filter((x) => !ph.responses[x]);
  if (!pending.length) return true;
  const chosen = seats.filter((x) => ph.responses[x]);
  const best = Math.max(0, ...chosen.map((x) => CLAIM_RANK[ph.responses[x]!.choice]));
  if (best === 0) return false;
  const dist = (x: Wind) => (x - ph.from + 4) % 4;
  const huChosen = chosen.filter((x) => ph.responses[x]!.choice === 'hu');
  return pending.every((x) => {
    const can = bestOption(ph.options[x]!);
    if (can < best) return true;
    if (can === 3 && best === 3 && !s.rules.multiWin) return dist(x) > Math.min(...huChosen.map(dist));
    return false;
  });
}

function resolveClaims(s: GameState) {
  const ph = s.phase;
  if (ph.kind !== 'claims') return;
  const k = kindOf(ph.tile);
  const order = [1, 2, 3].map((n) => next(ph.from, n));
  const chose = (c: ClaimChoice) => order.filter((seat) => ph.responses[seat]?.choice === c);

  for (const seat of order) {
    const p = s.players[seat];
    const choice = ph.responses[seat]?.choice;
    // 胡過水：有胡卻沒選胡，鎖住整組聽牌（含這張）
    if (ph.options[seat]?.hu && choice !== 'hu') {
      const melds = p.melds.map((m) => ({ type: m.type, tiles: kindsOf(m.tiles) }));
      p.passedWin = [...new Set([...p.passedWin, k, ...waits(kindsOf(p.hand), melds)])];
    }
    // 碰過水：能碰卻沒碰（過或改吃），到自己下一次輪到前不能再碰這種牌
    if (ph.options[seat]?.pon && choice !== 'pon' && choice !== 'kong' && choice !== 'hu') {
      p.passedPon = [...new Set([...(p.passedPon ?? []), k])];
    }
  }

  const hu = chose('hu');
  if (hu.length) {
    const winners = s.rules.multiWin ? hu : [hu[0]];
    return finishWithWins(s, winners.map((seat) => ({ seat, from: ph.from, tile: ph.tile })), {
      robKong: ph.robKong, lastTile: ph.lastDiscard,
    });
  }
  if (ph.robKong) return kongSupplement(s, ph.from);

  const take = (seat: Wind) => {
    const d = s.players[ph.from].discards;
    d.splice(d.lastIndexOf(ph.tile), 1);
    s.anyCall = true;
    return seat;
  };
  const kong = chose('kong')[0];
  if (kong !== undefined) {
    take(kong);
    s.players[kong].passedPon = [];
    const tiles = pullKinds(s.players[kong], [k, k, k]);
    const meld: MeldState = { type: 'minkan', tiles: [...tiles, ph.tile], from: ph.from };
    s.players[kong].melds.push(meld);
    emit(s, { t: 'meld', seat: kong, meld });
    // 大明槓：補上來的牌不能自摸
    return kongSupplement(s, kong, true);
  }
  const pon = chose('pon')[0];
  if (pon !== undefined) {
    take(pon);
    s.players[pon].passedPon = [];
    const tiles = pullKinds(s.players[pon], [k, k]);
    const meld: MeldState = { type: 'pon', tiles: [...tiles, ph.tile], from: ph.from };
    s.players[pon].melds.push(meld);
    emit(s, { t: 'meld', seat: pon, meld });
    // 碰上家的牌：這一手不能打同一張，也不能馬上加槓（下一輪才能補槓）
    const upper = pon === next(ph.from);
    s.phase = { kind: 'turn', seat: pon, drew: null, kongDraw: false, ...(upper ? { noDiscard: [k], noKakan: [k] } : {}) };
    return;
  }
  const chiSeat = chose('chi')[0];
  if (chiSeat !== undefined) {
    take(chiSeat);
    s.players[chiSeat].passedPon = [];
    const pair = ph.responses[chiSeat]!.chi!;
    const [lo, hi] = pullKinds(s.players[chiSeat], pair).sort((a, b) => kindOf(a) - kindOf(b));
    // 吃進來的那張擺在中間（例：五六條吃七條 → 五 七 六）
    const meld: MeldState = { type: 'chi', tiles: [lo, ph.tile, hi], from: ph.from };
    s.players[chiSeat].melds.push(meld);
    emit(s, { t: 'meld', seat: chiSeat, meld });
    s.phase = { kind: 'turn', seat: chiSeat, drew: null, kongDraw: false, noDiscard: chiForbidden(k, pair) };
    return;
  }
  drawTurn(s, next(ph.from));
}

function pullKinds(p: PlayerState, kinds: TileKind[]): TileId[] {
  return kinds.map((k) => {
    const idx = p.hand.findIndex((t) => kindOf(t) === k);
    if (idx < 0) throw new IllegalAction('missing tile for meld');
    return p.hand.splice(idx, 1)[0];
  });
}

/** 正常摸牌；牌牆只剩保留張數就流局 */
function drawTurn(s: GameState, seat: Wind) {
  if (remaining(s) <= s.rules.reserveTiles) return finishDraw(s);
  const p = s.players[seat];
  p.passedPon = [];
  p.drawCount++;
  const tile = s.wall[s.wallHead++];
  p.hand.push(tile);
  emit(s, { t: 'draw', seat, supplement: false });
  // 摸到花：先停著讓畫面看到，再由 flowerStep 亮花、補牌
  if (isFlower(kindOf(tile))) {
    s.phase = { kind: 'flowers', seat, opening: false, idx: 0, then: { kongDraw: false } };
    return;
  }
  s.phase = { kind: 'turn', seat, drew: tile, kongDraw: false };
}

/** 槓後從牌尾補牌 */
function kongSupplement(s: GameState, seat: Wind, fromDiscard = false) {
  if (remaining(s) <= 0) return finishDraw(s);
  const p = s.players[seat];
  const tile = s.wall[--s.wallTail];
  p.hand.push(tile);
  emit(s, { t: 'draw', seat, supplement: true });
  const then = { kongDraw: true, ...(fromDiscard ? { noTsumo: true } : {}) };
  if (isFlower(kindOf(tile))) {
    s.phase = { kind: 'flowers', seat, opening: false, idx: 0, then };
    return;
  }
  s.phase = { kind: 'turn', seat, drew: tile, ...then };
}

function doAnkan(s: GameState, seat: Wind, k: TileKind) {
  requireTurn(s, seat);
  if (!turnOptions(s, seat)!.ankan.includes(k)) throw new IllegalAction('cannot ankan');
  const p = s.players[seat];
  const meld: MeldState = { type: 'ankan', tiles: pullKinds(p, [k, k, k, k]) };
  p.melds.push(meld);
  s.anyCall = true;
  emit(s, { t: 'meld', seat, meld });
  // 暗槓不能被搶槓
  kongSupplement(s, seat);
}

function doKakan(s: GameState, seat: Wind, k: TileKind) {
  requireTurn(s, seat);
  if (!turnOptions(s, seat)!.kakan.includes(k)) throw new IllegalAction('cannot kakan');
  const p = s.players[seat];
  const [tile] = pullKinds(p, [k]);
  const meld = p.melds.find((m) => m.type === 'pon' && kindOf(m.tiles[0]) === k)!;
  meld.type = 'kakan';
  meld.tiles.push(tile);
  p.passedWin = []; // 加槓解除胡過水
  s.anyCall = true;
  emit(s, { t: 'meld', seat, meld });
  openClaims(s, seat, tile, true);
}

function doTsumo(s: GameState, seat: Wind) {
  const ph = requireTurn(s, seat);
  if (!turnOptions(s, seat)!.canTsumo) throw new IllegalAction('cannot tsumo');
  const p = s.players[seat];
  const tile = ph.drew ?? p.hand[p.hand.length - 1];
  const heavenly = seat === s.dealer && !s.anyDiscard && !s.anyCall && p.drawCount === 0;
  const earthly = seat !== s.dealer && !s.anyCall && p.drawCount === 1 && p.discards.length === 0;
  finishWithWins(s, [{ seat, tile }], {
    kongDraw: ph.kongDraw, lastTile: remaining(s) <= s.rules.reserveTiles, heavenly, earthly,
  });
}

// ---------------------------------------------------------------- 結束一局

function finishWithWins(
  s: GameState,
  wins: { seat: Wind; from?: Wind; tile: TileId }[],
  flags: { robKong?: boolean; kongDraw?: boolean; lastTile?: boolean; heavenly?: boolean; earthly?: boolean },
) {
  const money = handMoney(s);
  const records: WinRecord[] = [];
  for (const w of wins) {
    const p = s.players[w.seat];
    const self = w.from === undefined;
    const concealed = kindsOf(self ? p.hand : [...p.hand, w.tile]);
    const melds: Meld[] = p.melds.map((m) => ({ type: m.type, tiles: kindsOf(m.tiles) }));
    let score: ScoreResult;
    try {
      score = scoreHand({
        concealed, melds, winTile: kindOf(w.tile), selfDraw: self,
        seatWind: seatWindOf(s, w.seat), roundWind: s.roundWind,
        flowers: kindsOf(p.flowers), flowerBonusTaken: p.flowerBonusTaken,
        robKong: flags.robKong, kongDraw: self && flags.kongDraw, lastTile: flags.lastTile,
        heavenly: self && flags.heavenly, earthly: self && flags.earthly, miji: p.miji, tianting: !!p.tianting,
      }, s.rules.score.table);
    } catch (e) {
      if (e instanceof NotAWinError) throw new IllegalAction('not a winning hand');
      throw e;
    }
    const deltas = settleWin({
      winner: w.seat, discarder: w.from, handTai: score.total, noDealerTai: !!(self && flags.heavenly),
    }, s.rules.score, money);
    const dt = self && flags.heavenly ? 0 : dealerTai(s.rules.score, money);
    const involved = w.seat === s.dealer || w.from === s.dealer || self;
    records.push({
      seat: w.seat, from: w.from, winTile: w.tile, score, deltas,
      dealerTai: involved ? dt : 0,
      dealerOnly: self && w.seat !== s.dealer,
    });
  }
  // 胡的那張不放進手牌（畫面以 winTile 顯示），放槍的牌從捨牌區移除
  if (!flags.robKong && wins[0].from !== undefined) {
    const d = s.players[wins[0].from].discards;
    d.splice(d.lastIndexOf(wins[0].tile), 1);
  }
  if (flags.robKong && wins[0].from !== undefined) {
    // 被搶槓：加槓還原成碰
    const robbed = s.players[wins[0].from];
    const meld = robbed.melds.find((m) => m.type === 'kakan' && m.tiles.includes(wins[0].tile));
    if (meld) { meld.type = 'pon'; meld.tiles = meld.tiles.filter((t) => t !== wins[0].tile); }
  }
  const handDeltas = addDeltas(...records.map((r) => r.deltas));
  s.scores = addDeltas(s.scores, handDeltas);
  endHand(s, {
    type: 'win', wins: records, flowerBonus: s.flowerBonus,
    deltas: addDeltas(handDeltas, s.flowerBonus?.deltas ?? zeroDeltas()),
    dealerContinues: wins.some((w) => w.seat === s.dealer),
  });
}

function finishDraw(s: GameState) {
  endHand(s, {
    type: 'draw', wins: [], flowerBonus: s.flowerBonus,
    deltas: s.flowerBonus?.deltas ?? zeroDeltas(), dealerContinues: true,
  });
}

function endHand(s: GameState, result: HandResult) {
  sortHands(s);
  (s.history ??= []).push({
    handNo: s.handNo, roundWind: s.roundWind, dealer: s.dealer, dealerStreak: s.dealerStreak, leopard: s.leopard,
    type: result.type,
    wins: result.wins.map((w) => ({ seat: w.seat, from: w.from, tai: w.score.total, dealerTai: w.dealerTai, dealerOnly: w.dealerOnly })),
    flowerBonus: result.flowerBonus && { kind: result.flowerBonus.kind, to: result.flowerBonus.to, from: result.flowerBonus.from },
    deltas: result.deltas,
    totals: [...s.scores] as Deltas,
  });
  emit(s, { t: 'handOver', result });
  const matchEnds = !result.dealerContinues && next(s.dealer) === 0 && s.roundsDone + 1 >= s.rules.rounds;
  s.phase = matchEnds ? { kind: 'matchOver', result } : { kind: 'handOver', result };
}

function doNextHand(s: GameState) {
  if (s.phase.kind !== 'handOver') throw new IllegalAction('hand not over');
  const { dealerContinues } = s.phase.result;
  if (dealerContinues) s.dealerStreak++;
  else {
    s.dealerStreak = 0;
    s.dealer = next(s.dealer);
    if (s.dealer === 0) {
      s.roundsDone++;
      s.roundWind = next(s.roundWind);
    }
  }
  s.handNo++;
  startHand(s);
}

// ---------------------------------------------------------------- 給各家看的畫面

export interface PublicPlayer {
  handCount: number;
  melds: MeldState[];
  flowers: TileId[];
  discards: TileId[];
  /** 已報聽（公開） */
  declared: boolean;
  declareTile: TileId | null;
}

export interface PlayerView {
  seat: Wind;
  hand: TileId[];
  /** 自己的過水狀態（只給自己看）：不能胡的整組牌、這一巡不能碰的牌 */
  passedWin?: TileKind[];
  passedPon?: TileKind[];
  players: PublicPlayer[];
  /** 局結束時才公開所有人的手牌 */
  revealedHands?: TileId[][];
  wallRemaining: number;
  /** 牌牆畫面用：下一張摸牌與牌尾的位置（抓牌順序索引） */
  wallHead: number;
  wallTail: number;
  /** 開門那家（本局的東、1 花） */
  breakSeat: Wind;
  roundWind: Wind;
  dealer: Wind;
  dealerStreak: number;
  dice: [number, number, number];
  leopard: boolean;
  scores: Deltas;
  /** 計分總表（公開資訊） */
  history: HandRecord[];
  handNo: number;
  seq: number;
  phase:
    | { kind: 'turn'; seat: Wind; drew: TileId | null; options: TurnOptions | null }
    | { kind: 'claims'; from: Wind; tile: TileId; robKong: boolean; myOptions: ClaimOptions | null; responded: boolean }
    | { kind: 'flowers'; seat: Wind; opening: boolean }
    | { kind: 'handOver' | 'matchOver'; result: HandResult };
}

/** 只把該玩家看得到的資訊傳出去（規格書 8：其他人看不到別人的牌） */
export function viewFor(s: GameState, seat: Wind): PlayerView {
  const ph = s.phase;
  const over = ph.kind === 'handOver' || ph.kind === 'matchOver';
  let phase: PlayerView['phase'];
  if (ph.kind === 'turn') {
    phase = { kind: 'turn', seat: ph.seat, drew: ph.seat === seat ? ph.drew : null, options: turnOptions(s, seat) };
  } else if (ph.kind === 'claims') {
    phase = {
      kind: 'claims', from: ph.from, tile: ph.tile, robKong: ph.robKong,
      myOptions: ph.options[seat] ?? null, responded: !!ph.responses[seat],
    };
  } else if (ph.kind === 'flowers') {
    phase = { kind: 'flowers', seat: ph.seat, opening: ph.opening };
  } else phase = { kind: ph.kind, result: ph.result };
  return {
    seat,
    hand: [...s.players[seat].hand],
    passedWin: [...s.players[seat].passedWin], passedPon: [...(s.players[seat].passedPon ?? [])],
    players: s.players.map((p, i) => ({
      handCount: p.hand.length,
      // 別人的暗槓在局結束前只顯示牌背（-1）
      melds: p.melds.map((m) => (m.type === 'ankan' && !over && i !== seat ? { ...m, tiles: m.tiles.map(() => -1) } : m)),
      flowers: p.flowers, discards: p.discards, declared: !!p.declared, declareTile: p.declareTile ?? null,
    })),
    revealedHands: over ? s.players.map((p) => [...p.hand]) : undefined,
    wallRemaining: remaining(s), wallHead: s.wallHead, wallTail: s.wallTail, breakSeat: s.breakSeat ?? s.dealer,
    roundWind: s.roundWind, dealer: s.dealer, dealerStreak: s.dealerStreak,
    dice: s.dice, leopard: s.leopard, scores: s.scores, history: s.history ?? [], handNo: s.handNo, seq: s.seq, phase,
  };
}
