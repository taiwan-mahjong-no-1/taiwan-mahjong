/**
 * 四個 AI 自動對打，檢查牌數守恆與分數總和為零，並統計胡牌率。
 * 用法：npm run sim -- [局數] [難度]
 */
import { decide, AiLevel } from '../src/ai/ai';
import { apply, DEFAULT_RULES, newGame, viewFor, GameState } from '../src/engine/game';
import { createRng } from '../src/engine/rng';
import { Wind } from '../src/engine/tiles';

export function simulate(hands: number, levels: AiLevel[], seed = 1) {
  const rng = createRng(seed);
  const stats = { hands: 0, wins: 0, selfDraw: 0, draws: 0, flowerBonus: 0, multiWin: 0, taiTotal: 0, maxTai: 0, errors: 0 };
  const taiNames = new Map<string, number>();
  /** 各座位統計：總得分、胡牌次數、放槍次數（座位固定對應難度，用來比較不同難度） */
  const perSeat = [0, 1, 2, 3].map(() => ({ points: 0, wins: 0, dealIns: 0 }));
  let game = 0;
  while (stats.hands < hands) {
    const s: GameState = newGame({ ...DEFAULT_RULES, rounds: 4, multiWin: game % 3 === 0 }, seed * 100000 + game++);
    for (let step = 0; step < 100000 && s.phase.kind !== 'matchOver' && stats.hands < hands; step++) {
      const ph = s.phase;
      if (ph.kind === 'handOver') {
        record(s);
        apply(s, { type: 'nextHand' });
        continue;
      }
      if (ph.kind === 'flowers') {
        apply(s, { type: 'flowerStep' });
        continue;
      }
      let acted = false;
      for (const seat of [0, 1, 2, 3] as Wind[]) {
        const a = decide(viewFor(s, seat), levels[seat], rng);
        if (a) { apply(s, a); acted = true; break; }
      }
      if (!acted) throw new Error(`stuck in ${ph.kind}`);
    }
    if (s.phase.kind === 'matchOver') record(s);
  }
  function record(s: GameState) {
    if (s.phase.kind !== 'handOver' && s.phase.kind !== 'matchOver') return;
    const r = s.phase.result;
    stats.hands++;
    if (s.scores.reduce((a, b) => a + b, 0) !== 0) stats.errors++;
    if (r.flowerBonus) stats.flowerBonus++;
    r.deltas.forEach((d, i) => { perSeat[i].points += d; });
    for (const w of r.wins) {
      perSeat[w.seat].wins++;
      if (w.from !== undefined) perSeat[w.from].dealIns++;
    }
    if (r.type === 'draw') stats.draws++;
    else {
      stats.wins++;
      if (r.wins.length > 1) stats.multiWin++;
      if (r.wins[0].from === undefined) stats.selfDraw++;
      for (const w of r.wins) {
        stats.taiTotal += w.score.total;
        stats.maxTai = Math.max(stats.maxTai, w.score.total);
        for (const i of w.score.items) taiNames.set(i.name.split(' ')[0], (taiNames.get(i.name.split(' ')[0]) ?? 0) + 1);
      }
    }
  }
  return { stats, taiNames, perSeat };
}

