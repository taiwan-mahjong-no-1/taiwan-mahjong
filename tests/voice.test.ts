import { describe, expect, it } from 'vitest';
import { apply, viewFor } from '../src/engine/game';
import { announce, voiceSnap } from '../src/ui/voice';
import { discard, passAll, stackedGame } from './helpers';

const HANDS = {
  E: '1p5p9p 1s3s5s9s EEE SSS WWW C',
  S: '123m456m789m234p78sNN',
  W: '6s 1p5p9p 3s5s9s FFF PPP 66p 5m',
  N: '123m456m789m234p78sNN',
  draws: '1s 2m 3p 6s',
};

describe('語音：畫面變化要念什麼', () => {
  it('出牌念牌名；胡別人的牌時胡的人念「胡了」、放槍的人念「放槍」', () => {
    const s = stackedGame(HANDS);
    let prev = voiceSnap(viewFor(s, 0));
    discard(s, 0, 'C');
    expect(announce(prev, viewFor(s, 0))).toEqual(['dragon_red']);
    passAll(s);
    prev = voiceSnap(viewFor(s, 0));
    discard(s, 1, '1s');
    passAll(s);
    discard(s, 2, '6s');
    expect(announce(prev, viewFor(s, 0))).toEqual(['s1', 's6']);
    const mid = voiceSnap(viewFor(s, 0));
    apply(s, { type: 'claim', seat: 3, choice: 'pass' });
    apply(s, { type: 'claim', seat: 1, choice: 'hu' });
    // 南家胡西家：南家聽到「胡了」、西家聽到「放槍」，東家、北家不播
    expect(announce(mid, viewFor(s, 1))).toContain('hule');
    expect(announce(mid, viewFor(s, 2))).toContain('fangqiang');
    expect(announce(mid, viewFor(s, 0))).not.toContain('hule');
    expect(announce(mid, viewFor(s, 0))).not.toContain('fangqiang');
    expect(announce(mid, viewFor(s, 3))).toEqual([]);
  });

  it('換局或第一次顯示不念（避免一進來就一連串）', () => {
    const s = stackedGame(HANDS);
    expect(announce(null, viewFor(s, 0))).toEqual([]);
  });
});

describe('語音：同一次更新裡的先後順序', () => {
  it('打出的牌先念，下家補花後念（不論座位順序）', () => {
    // 北家打牌、沒人要，接著東家摸到花補花：同一次更新
    const s = stackedGame({ ...HANDS, draws: '1s 2m 3p f2' });
    discard(s, 0, 'C');
    passAll(s);
    discard(s, 1, '1s');
    passAll(s);
    discard(s, 2, '2m');
    passAll(s);
    const prev = voiceSnap(viewFor(s, 0));
    discard(s, 3, '3p'); // 沒人要 → 東家摸到夏（花）→ 補花
    passAll(s);
    const said = announce(prev, viewFor(s, 0));
    expect(said.indexOf('p3')).toBeGreaterThanOrEqual(0);
    expect(said.indexOf('flower')).toBeGreaterThan(said.indexOf('p3'));
  });
});
