import { describe, expect, it } from 'vitest';
import { TableController } from '../src/game/controller';
import { discard, passAll, stackedGame } from './helpers';
import { parseTiles } from '../src/engine/tiles';

const HANDS = {
  E: '1p5p9p 1s3s5s9s EEE SSS WWW C',
  S: '123m456m789m234p78sNN',
  W: '6s 1p5p9p 3s5s9s FFF PPP 66p 5m',
  N: '123m456m789m234p78sNN',
  draws: '1s 2m 3p 6s',
};
const humans = [0, 1, 2, 3].map((i) => ({ name: `P${i}`, kind: 'human' as const }));

describe('牌桌控制器：逾時', () => {
  it('宣告逾時時能胡就自動胡，不當成放棄（不會進入胡過水）', async () => {
    const s = stackedGame(HANDS, { multiWin: true });
    discard(s, 0, 'C');
    passAll(s);
    discard(s, 1, '1s');
    passAll(s);
    discard(s, 2, '6s'); // 南、北都能胡
    const ctl = new TableController(s.rules, humans, { discardSeconds: 0.05, claimSeconds: 0.05 }, 1, [1, 1], s);
    await new Promise((r) => setTimeout(r, 300));
    ctl.destroy();
    const ph = ctl.state.phase;
    if (ph.kind !== 'handOver') throw new Error(`expected handOver, got ${ph.kind}`);
    expect(ph.result.wins.map((w) => w.seat).sort()).toEqual([1, 3]);
  });

});

describe('牌桌控制器：聽牌自動摸打（沒台的聽牌，只有自己知道）', () => {
  it('開啟後摸到的牌自動打掉、別人打出能胡的牌自動胡；別人看不到', async () => {
    const s = stackedGame(HANDS);
    discard(s, 0, 'C');
    passAll(s); // 南家摸 1 條（聽 6、9 條）
    const ctl = new TableController(s.rules, humans, { discardSeconds: 0, claimSeconds: 0 }, 1, [1, 1], s);
    ctl.setAutoTing(1, true);
    expect(ctl.viewFor(1).autoTing).toBe(true);
    expect(ctl.viewFor(0).autoTing).toBe(false);
    expect(JSON.stringify(ctl.viewFor(0))).not.toContain('"autoTing":true');
    await new Promise((r) => setTimeout(r, 50));
    expect(ctl.state.players[1].discards.map((t) => Math.floor(t / 4))).toEqual([parseTiles('1s')[0]]);
    // 西家打 6 條：南家自動胡；北家也能胡，手動放過
    const w6 = ctl.state.players[2].hand.find((t) => Math.floor(t / 4) === parseTiles('6s')[0])!;
    ctl.act(2, { type: 'discard', seat: 2, tile: w6 });
    ctl.act(3, { type: 'claim', seat: 3, choice: 'pass' });
    await new Promise((r) => setTimeout(r, 50));
    ctl.destroy();
    const ph = ctl.state.phase;
    if (ph.kind !== 'handOver') throw new Error(`expected handOver, got ${ph.kind}`);
    expect(ph.result.wins.map((w) => w.seat)).toEqual([1]);
  });

  it('自己打成沒聽牌時自動關閉', () => {
    const s = stackedGame(HANDS);
    discard(s, 0, 'C');
    passAll(s);
    const ctl = new TableController(s.rules, humans, { discardSeconds: 0, claimSeconds: 0 }, 1, [5000, 5000], s);
    ctl.setAutoTing(1, true);
    const n = ctl.state.players[1].hand.find((t) => Math.floor(t / 4) === parseTiles('N')[0])!;
    expect(ctl.act(1, { type: 'discard', seat: 1, tile: n })).toBeNull(); // 拆掉眼，不聽了
    expect(ctl.viewFor(1).autoTing).toBe(false);
    ctl.destroy();
  });
});
