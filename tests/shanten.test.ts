import { describe, expect, it } from 'vitest';
import { shanten } from '../src/ai/shanten';
import { isWinningShape, waits } from '../src/engine/hand';
import { createRng, shuffle } from '../src/engine/rng';
import { parseTiles } from '../src/engine/tiles';

describe('向聽數', () => {
  it('已胡 = -1、聽牌 = 0', () => {
    expect(shanten(parseTiles('123m456m789m234p678sNN'), 0)).toBe(-1);
    expect(shanten(parseTiles('123m456m789m234p78sNN'), 0)).toBe(0);
    expect(shanten(parseTiles('123m456m789m234p79sNS'), 0)).toBe(1);
    expect(shanten(parseTiles('11m55m99m22p77p33s88sNN'), 0)).toBe(0); // 8 對，嚦咕嚦咕聽牌
    expect(shanten(parseTiles('NN'), 5)).toBe(-1);
    expect(shanten(parseTiles('N'), 5)).toBe(0);
  });

  it('隨機胡牌型：-1；拿掉一張為 0 且有聽；換掉一張與胡牌判定一致', () => {
    const rng = createRng(11);
    const r = (n: number) => Math.floor(rng() * n);
    for (let i = 0; i < 3000; i++) {
      const hand: number[] = [];
      const pair = r(34);
      hand.push(pair, pair);
      for (let k = 0; k < 5; k++) {
        if (rng() < 0.5) { const t = r(34); hand.push(t, t, t); }
        else { const suit = r(3); const st = suit * 9 + r(7); hand.push(st, st + 1, st + 2); }
      }
      const counts = new Map<number, number>();
      hand.forEach((t) => counts.set(t, (counts.get(t) ?? 0) + 1));
      if ([...counts.values()].some((v) => v > 4)) continue;
      expect(shanten(hand, 0)).toBe(-1);
      const pre = [...hand];
      pre.splice(r(pre.length), 1);
      expect(shanten(pre, 0)).toBe(0);
      expect(waits(pre, []).length).toBeGreaterThan(0);
      const swapped = [...pre, r(34)];
      expect(shanten(swapped, 0) === -1).toBe(isWinningShape(swapped, 0));
      expect(shanten(swapped, 0) <= 1).toBe(true);
    }
  });

  it('與胡牌判定一致：隨機 2000 手，聽牌 ⇔ 有聽的牌', () => {
    const rng = createRng(3);
    const all = Array.from({ length: 136 }, (_, i) => Math.floor(i / 4));
    for (let i = 0; i < 2000; i++) {
      const hand = shuffle([...all], rng).slice(0, 16);
      const s = shanten(hand, 0);
      expect(s === 0).toBe(waits(hand, []).length > 0);
      const win = shuffle([...all], rng).slice(0, 17);
      expect(shanten(win, 0) === -1).toBe(isWinningShape(win, 0));
    }
  });
});
