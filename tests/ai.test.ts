import { describe, expect, it } from 'vitest';
import { simulate } from '../tools/simulate';

describe('AI 對打', () => {
  it('三種難度混合對打 150 局：分數總和為零、多數局有人胡', () => {
    const { stats } = simulate(150, ['easy', 'normal', 'hard', 'normal'], 5);
    expect(stats.errors).toBe(0);
    expect(stats.hands).toBe(150);
    expect(stats.wins / stats.hands).toBeGreaterThan(0.6);
  }, 60000);
});

// ---------------------------------------------------------------- 困難 AI 的防守與棄胡

import { decide, foldLimit } from '../src/ai/ai';
import { PlayerView, TileId } from '../src/engine/game';
import { createRng } from '../src/engine/rng';
import { parseTiles, Wind } from '../src/engine/tiles';

/** 用牌的文字寫法組出實體牌（每種牌依序取第 0、1、2、3 張） */
function tilesOf(str: string, used = new Map<number, number>()): TileId[] {
  return parseTiles(str).map((k) => {
    const n = used.get(k) ?? 0;
    used.set(k, n + 1);
    return k * 4 + n;
  });
}

function viewWith(opts: {
  hand: string; wall: number; phase: PlayerView['phase'];
  opp?: Partial<Record<1 | 2 | 3, { discards?: string; declare?: boolean }>>;
}): PlayerView {
  const used = new Map<number, number>();
  const hand = tilesOf(opts.hand, used);
  const players = ([0, 1, 2, 3] as Wind[]).map((seat) => {
    const o = seat === 0 ? undefined : opts.opp?.[seat as 1 | 2 | 3];
    const discards = o?.discards ? tilesOf(o.discards, used) : [];
    return {
      handCount: seat === 0 ? hand.length : 16, melds: [], flowers: [], discards,
      declared: !!o?.declare, declareTile: o?.declare ? discards[0] : null,
    };
  });
  return {
    seat: 0, hand, players, wallRemaining: opts.wall, wallHead: 0, wallTail: opts.wall, breakSeat: 0,
    roundWind: 0, dealer: 0, dealerStreak: 0, dice: [1, 2, 2], leopard: false, scores: [0, 0, 0, 0],
    history: [], handNo: 0, seq: 1, phase: opts.phase,
  };
}

const TURN = (drew: TileId | null): PlayerView['phase'] => ({
  kind: 'turn', seat: 0, drew,
  options: { canTsumo: false, ankan: [], kakan: [], canDeclare: false, declared: false, tingBonus: null },
} as unknown as PlayerView['phase']);

describe('困難 AI：棄胡與防守', () => {
  it('棄胡門檻：前段向聽 6、剩 65 張以下 5、中段 4、後段 3', () => {
    expect(foldLimit(75)).toBe(6);
    expect(foldLimit(60)).toBe(5);
    expect(foldLimit(45)).toBe(4);
    expect(foldLimit(30)).toBe(3);
  });

  // 牌型很散（向聽數高）的 17 張手牌，含一張 5 筒
  const BAD = '1m4m7m 2p5p8p 3s6s9s E S W N C F P 9m';

  it('牌局後段手牌很差：打出報聽那家摸打掉的牌（最安全）', () => {
    const v = viewWith({ hand: BAD, wall: 30, phase: TURN(null), opp: { 1: { discards: '3m 5p', declare: true } } });
    const a = decide(v, 'hard', createRng(1));
    expect(a).toMatchObject({ type: 'discard' });
    // 5 筒是南家報聽後才摸打掉的牌，對他 100% 安全
    expect(Math.floor((a as { tile: number }).tile / 4)).toBe(parseTiles('5p')[0]);
  });

  it('普通 AI 不防守，照樣以牌型選牌（不一定打 5 筒）', () => {
    const picks = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const v = viewWith({ hand: BAD, wall: 30, phase: TURN(null), opp: { 1: { discards: '3m 5p', declare: true } } });
      const a = decide(v, 'normal', createRng(i)) as { tile: number };
      picks.add(Math.floor(a.tile / 4));
    }
    expect(picks.size).toBeGreaterThan(1);
  });

  it('棄胡時不碰牌', () => {
    const phase = {
      kind: 'claims', from: 3, tile: parseTiles('C')[0] * 4 + 3, robKong: false, responded: false,
      myOptions: { hu: false, pon: true, kong: false, chi: [] },
    } as unknown as PlayerView['phase'];
    const bad = '1m4m7m 2p5p8p 3s6s9s E S W N CC P';
    expect(decide(viewWith({ hand: bad, wall: 30, phase }), 'hard', createRng(1))).toMatchObject({ choice: 'pass' });
    expect(decide(viewWith({ hand: bad, wall: 30, phase }), 'easy', createRng(1))).toMatchObject({ choice: 'pon' });
  });
});

// ---------------------------------------------------------------- 輔助模式

import { suggest } from '../src/ai/ai';

describe('輔助模式：建議與原因', () => {
  it('打出就聽牌時，建議那張並說明聽哪些牌、還剩幾張', () => {
    const v = viewWith({ hand: '123m456m789m234p78sNN W', wall: 50, phase: TURN(null) });
    const a = suggest(v, 'hard', createRng(1))!;
    expect(a.action).toMatchObject({ type: 'discard' });
    expect(Math.floor((a.action as { tile: number }).tile / 4)).toBe(parseTiles('W')[0]);
    expect(a.reason).toContain('聽牌');
    expect(a.reason).toContain('六條');
    expect(a.reason).toContain('九條');
  });

  it('防守時說明為什麼打這張', () => {
    const v = viewWith({ hand: '1m4m7m 2p5p8p 3s6s9s E S W N C F P 9m', wall: 30, phase: TURN(null), opp: { 1: { discards: '3m 5p', declare: true } } });
    const a = suggest(v, 'hard', createRng(1))!;
    expect(a.reason).toContain('防守');
  });
});
