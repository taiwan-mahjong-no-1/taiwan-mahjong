import { describe, expect, it } from 'vitest';
import fixtures from './fixtures/scoring-cases.json';
import { Meld, MeldType } from '../src/engine/hand';
import { scoreHand } from '../src/engine/scoring';
import { DEFAULT_SCORE_RULES, HandMoney, addDeltas, settleFlowerBonus, settleWin } from '../src/engine/settlement';
import { parseTiles, Wind } from '../src/engine/tiles';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fixture = Record<string, any>;
const SEAT: Record<string, Wind> = { E: 0, S: 1, W: 2, N: 3 };
const cases = fixtures.cases as Fixture[];

const toMelds = (ms: [string, string][] = []): Meld[] =>
  ms.map(([type, tiles]) => ({ type: type as MeldType, tiles: parseTiles(tiles) }));

const sortItems = (items: { name: string; tai: number }[]) =>
  items.map((i) => `${i.name}:${i.tai}`).sort();

function money(c: Fixture): HandMoney {
  return { dealer: 0, dealerStreak: c.dealerStreak ?? 0, leopard: !!c.leopard };
}

function score(c: Fixture) {
  const ctx = c.context ?? {};
  return scoreHand({
    concealed: parseTiles(c.concealed),
    melds: toMelds(c.melds),
    winTile: parseTiles(c.winTile)[0],
    selfDraw: c.winType === 'self',
    seatWind: SEAT[c.winner],
    roundWind: SEAT[c.roundWind ?? 'E'],
    flowers: parseTiles((c.flowers ?? []).join('')),
    ...ctx,
  });
}

describe('台數計算（規則測試案例）', () => {
  for (const c of cases.filter((c) => c.kind === 'scoring')) {
    it(`${c.id} ${c.title}`, () => {
      const r = score(c);
      expect(sortItems(r.items)).toEqual(sortItems(c.tai));
      expect(r.total).toBe(c.expectedTotalTai);
    });
  }
});

describe('分數結算（規則測試案例）', () => {
  for (const c of cases.filter((c) => c.kind !== 'process' || c.flowerBonus)) {
    if (c.expectNoWin) continue;
    it(`${c.id} ${c.title}`, () => {
      const rules = { ...DEFAULT_SCORE_RULES, base: c.base, perTai: c.perTai };
      const m = money(c);
      const parts = [];
      for (const fb of c.flowerBonus ?? []) {
        const kind = fb.kind === '八仙過海' ? 'eightImmortals' : 'sevenRobOne';
        parts.push(settleFlowerBonus(kind, SEAT[fb.to], fb.from ? SEAT[fb.from] : undefined, rules, m));
      }
      if (c.winner) {
        parts.push(settleWin({
          winner: SEAT[c.winner],
          discarder: c.winType === 'self' ? undefined : SEAT[c.discarder],
          handTai: c.kind === 'scoring' ? score(c).total : c.expectedTotalTai,
          noDealerTai: !!c.context?.heavenly,
        }, rules, m));
      }
      for (const ex of c.extraWins ?? []) {
        const tai = ex.tai.reduce((s: number, t: { tai: number }) => s + t.tai, 0);
        parts.push(settleWin({ winner: SEAT[ex.winner], discarder: SEAT[c.discarder], handTai: tai }, rules, m));
      }
      const got = addDeltas(...parts);
      const want = [c.expectedDelta.E, c.expectedDelta.S, c.expectedDelta.W, c.expectedDelta.N];
      expect(got).toEqual(want);
    });
  }
});
