import { DEFAULT_TAI, TaiTable } from './scoring';
import { Wind, WINDS } from './tiles';

export interface ScoreRules {
  base: number; // 底
  perTai: number; // 每台分數
  /** 豹子加倍開關（房間設定） */
  leopardDouble: boolean;
  table: TaiTable;
}

export const DEFAULT_SCORE_RULES: ScoreRules = { base: 30, perTai: 10, leopardDouble: true, table: DEFAULT_TAI };

export type Deltas = [number, number, number, number];
export const zeroDeltas = (): Deltas => [0, 0, 0, 0];

export interface HandMoney {
  dealer: Wind;
  /** 連莊數 */
  dealerStreak: number;
  /** 本局開局擲出豹子 */
  leopard: boolean;
}

const multiplier = (rules: ScoreRules, m: HandMoney) => (m.leopard && rules.leopardDouble ? 2 : 1);

/** 莊家與連莊的台數：只在莊家是贏家或付款人時計 */
export function dealerTai(rules: ScoreRules, m: HandMoney): number {
  return rules.table.dealer + rules.table.streak * m.dealerStreak;
}

export interface WinPayment {
  winner: Wind;
  /** 放槍者；自摸為 undefined */
  discarder?: Wind;
  /** 胡牌台數（scoreHand 的 total，不含莊家與連莊） */
  handTai: number;
  /** 天胡不另計莊家台 */
  noDealerTai?: boolean;
}

/**
 * 胡牌結算：每位付款人付 (底 + (台數 + 莊家台) × 每台分數) × 倍數（豹子局倍數為 2）。
 * 一炮多響時，對每位胡牌者各呼叫一次再相加。
 */
export function settleWin(p: WinPayment, rules: ScoreRules, m: HandMoney): Deltas {
  const d = zeroDeltas();
  const payers = p.discarder === undefined ? WINDS.filter((w) => w !== p.winner) : [p.discarder];
  const mult = multiplier(rules, m);
  for (const payer of payers) {
    const dt = !p.noDealerTai && (p.winner === m.dealer || payer === m.dealer) ? dealerTai(rules, m) : 0;
    // 豹子：（底 + 台數 × 每台）算完後整筆加倍
    const amount = (rules.base + (p.handTai + dt) * rules.perTai) * mult;
    d[payer] -= amount;
    d[p.winner] += amount;
  }
  return d;
}

/**
 * 花牌立即收分（規格書 3.10）：
 * - 八仙過海：其他三家各付 8 台
 * - 七搶一：只由持 1 張花的那家付 8 台
 * 不含底；豹子局加倍。
 */
export function settleFlowerBonus(
  kind: 'eightImmortals' | 'sevenRobOne', to: Wind, from: Wind | undefined, rules: ScoreRules, m: HandMoney,
): Deltas {
  const d = zeroDeltas();
  const amount = rules.table.flowerBonus * multiplier(rules, m) * rules.perTai;
  const payers = kind === 'eightImmortals' ? WINDS.filter((w) => w !== to) : [from!];
  for (const payer of payers) {
    d[payer] -= amount;
    d[to] += amount;
  }
  return d;
}

export const addDeltas = (...ds: Deltas[]): Deltas =>
  ds.reduce((acc, d) => acc.map((v, i) => v + d[i]) as Deltas, zeroDeltas());
