/**
 * 牌牆位置（規格書 3.2）：四家面前各一道牌牆，每道 18 墩、每墩 2 張，共 144 張。
 *
 * - 骰子點數合計從莊家起算（莊家為 1、下家為 2……）決定開門的那道牌牆。
 * - 在開門那道牌牆從右邊數過點數那麼多墩，由缺口左側開始往左抓牌，抓完再接上家的牌牆。
 * - 數過的那幾墩是牌尾，補花、補槓從缺口右側往回拿。
 *
 * game.ts 裡的 wall 陣列就是「抓牌順序」：wall[0] 是開門後第一張，wall[143] 是牌尾第一張。
 * 洗牌本身是均勻亂數，所以牌牆實際位置只影響畫面與門風，不影響發到的牌。
 */
import type { Wind } from './tiles';

export const STACKS_PER_WALL = 18;
export const TOTAL_STACKS = STACKS_PER_WALL * 4;

export const diceTotal = (dice: readonly number[]) => dice.reduce((a, b) => a + b, 0);

/** 開門的座位：從莊家起算，數到骰子點數合計的那一家 */
export const breakSeatOf = (dealer: Wind, dice: readonly number[]) =>
  ((dealer + diceTotal(dice) - 1) % 4) as Wind;

/** 抓牌順序的第 j 墩在誰的牌牆、從那家右邊數來第幾墩（0 起算） */
export function stackPosition(breakSeat: Wind, total: number, j: number): { seat: Wind; fromRight: number } {
  const q = (((total + j) % TOTAL_STACKS) + TOTAL_STACKS) % TOTAL_STACKS;
  return {
    seat: ((breakSeat - Math.floor(q / STACKS_PER_WALL) + 8) % 4) as Wind,
    fromRight: q % STACKS_PER_WALL,
  };
}

/** 抓牌順序的第 j 墩還剩幾張（wallHead ~ wallTail 之間是還沒摸的牌） */
export function stackCount(j: number, head: number, tail: number): number {
  let n = 0;
  for (const i of [2 * j, 2 * j + 1]) if (i >= head && i < tail) n++;
  return n;
}
