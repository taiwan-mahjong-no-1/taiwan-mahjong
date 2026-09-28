import { AiLevel } from '../src/ai/ai';
import { simulate } from './simulate';

{
  const args = process.argv.slice(2);
  const n = Number(args[0] ?? 1000);
  // 難度可寫 mixed：簡單、普通、困難混合
  const level = args[1] ?? 'normal';
  const seed = Number(args[2] ?? 1);
  // 也可寫 hard,normal,hard,normal 指定四個座位
  const levels: AiLevel[] = level === 'mixed' ? ['normal', 'hard', 'easy', 'normal']
    : level.includes(',') ? (level.split(',') as AiLevel[]) : Array(4).fill(level as AiLevel);
  const t0 = Date.now();
  const { stats, taiNames, perSeat } = simulate(n, levels, seed);
  console.log(JSON.stringify(stats));
  console.log(`胡牌率 ${(stats.wins / stats.hands * 100).toFixed(1)}%，自摸 ${(stats.selfDraw / Math.max(1, stats.wins) * 100).toFixed(1)}%，平均台數 ${(stats.taiTotal / Math.max(1, stats.wins)).toFixed(2)}`);
  console.log([...taiNames].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '));
  // 依難度彙總：每局平均得分、胡牌率、放槍率
  const byLevel = new Map<string, { seats: number; points: number; wins: number; dealIns: number }>();
  levels.forEach((lv, i) => {
    const b = byLevel.get(lv) ?? { seats: 0, points: 0, wins: 0, dealIns: 0 };
    b.seats++; b.points += perSeat[i].points; b.wins += perSeat[i].wins; b.dealIns += perSeat[i].dealIns;
    byLevel.set(lv, b);
  });
  for (const [lv, b] of byLevel) {
    const per = stats.hands * b.seats;
    console.log(`${lv}：每局平均 ${(b.points / per).toFixed(2)} 分，胡牌 ${(b.wins / per * 100).toFixed(1)}%，放槍 ${(b.dealIns / per * 100).toFixed(1)}%`);
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
}
