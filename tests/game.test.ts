import { describe, expect, it } from 'vitest';
import { apply, DEFAULT_RULES, GameState, IllegalAction, newGame, remaining, seatWindOf, turnOptions, viewFor } from '../src/engine/game';
import { breakSeatOf, stackCount, stackPosition } from '../src/engine/wall';
import { createRng } from '../src/engine/rng';
import { Wind } from '../src/engine/tiles';
import { assertConservation, discard, passAll, stackedGame, stackWall } from './helpers';

/**
 * 基本牌局：南家、北家都聽 6、9 條；西家手上有一張 6 條。
 * E 先打中，S 摸 1 條打 1 條，W 摸 2 萬後打 6 條。
 */
const TWO_WAITERS = {
  E: '1p5p9p 1s3s5s9s EEE SSS WWW C',
  S: '123m456m789m234p78sNN',
  W: '6s 1p5p9p 3s5s9s FFF PPP 66p 5m',
  N: '123m456m789m234p78sNN',
  draws: '1s 2m 3p 6s',
};

function toWDiscards6s(s: GameState) {
  discard(s, 0, 'C');
  passAll(s);
  discard(s, 1, '1s');
  passAll(s);
  discard(s, 2, '6s');
}

describe('宣告與流程', () => {
  it('R02 截胡：南北都能胡，由西家逆時針最近的北家胡', () => {
    const s = stackedGame(TWO_WAITERS);
    toWDiscards6s(s);
    expect(s.phase.kind).toBe('claims');
    apply(s, { type: 'claim', seat: 1, choice: 'hu' });
    apply(s, { type: 'claim', seat: 3, choice: 'hu' });
    expect(s.phase.kind).toBe('handOver');
    if (s.phase.kind !== 'handOver') return;
    expect(s.phase.result.wins.map((w) => w.seat)).toEqual([3]);
    expect(s.phase.result.wins[0].score.items.map((i) => i.name)).toEqual(['門清']);
    expect(s.scores).toEqual([0, 0, -40, 40]);
  });

  it('R01 一炮多響：南北都胡，西家分別付', () => {
    const s = stackedGame(TWO_WAITERS, { multiWin: true });
    toWDiscards6s(s);
    apply(s, { type: 'claim', seat: 1, choice: 'hu' });
    apply(s, { type: 'claim', seat: 3, choice: 'hu' });
    if (s.phase.kind !== 'handOver') throw new Error('expected handOver');
    expect(s.phase.result.wins.map((w) => w.seat).sort()).toEqual([1, 3]);
    expect(s.scores).toEqual([0, 40, -80, 40]);
    // 莊家不在胡牌者之中 → 下莊
    expect(s.phase.result.dealerContinues).toBe(false);
  });

  it('R03 胡過水：南家放過 6 條，之後別人打 6 條不能胡；北家打出非聽牌（3 筒）後解除', () => {
    const s = stackedGame({ ...TWO_WAITERS, draws: '1s 2m 3p 6s 9p' });
    toWDiscards6s(s);
    passAll(s); // 南、北都放過
    // 過水鎖住整組聽牌：6 條與 9 條
    expect([...s.players[1].passedWin].sort()).toEqual([parseKind('6s'), parseKind('9s')].sort());
    // 北家摸 3 筒打出（3 筒不在他的聽牌組裡）→ 解除
    expect(s.phase).toMatchObject({ kind: 'turn', seat: 3 });
    discard(s, 3, '3p');
    expect(s.players[3].passedWin).toEqual([]);
    passAll(s);
    // 東家摸 6 條打出
    discard(s, 0, '6s');
    if (s.phase.kind !== 'claims') throw new Error('expected claims');
    expect(s.phase.options[1]?.hu).toBe(false); // 南家仍在過水（沒有打出非聽牌）
    expect(s.phase.options[3]?.hu).toBe(true); // 北家已解除
    expect(() => apply(s, { type: 'claim', seat: 1, choice: 'hu' })).toThrow(IllegalAction);
  });

  it('R04／R07 胡過水：自摸聽牌組的牌也不能胡、打出聽牌組的牌不解除；打出非聽牌才解除', () => {
    const s = stackedGame({ ...TWO_WAITERS, draws: '1s 2m 3p 6s 9s 5m 1p 7m 5p 1p' });
    toWDiscards6s(s);
    passAll(s); // 南、北都過水（聽 6、9 條）
    discard(s, 3, '3p'); // 北家打非聽牌，解除
    passAll(s);
    discard(s, 0, '6s'); // 東家打 6 條：北家再放過 → 北家又過水
    passAll(s);
    // 南家摸到 9 條：在聽牌組裡，不能自摸
    expect(s.phase).toMatchObject({ kind: 'turn', seat: 1 });
    expect(turnOptions(s, 1)!.canTsumo).toBe(false);
    expect(() => apply(s, { type: 'tsumo', seat: 1 })).toThrow(IllegalAction);
    discard(s, 1, '9s'); // 打出聽牌組裡的 9 條：不解除
    expect(s.players[1].passedWin).toContain(parseKind('9s'));
    passAll(s);
    discard(s, 2, '5m');
    passAll(s);
    discard(s, 3, '1p'); // 北家打非聽牌，解除
    passAll(s);
    discard(s, 0, '7m');
    passAll(s);
    discard(s, 1, '5p'); // 南家摸 5 筒打出：非聽牌，解除
    expect(s.players[1].passedWin).toEqual([]);
    passAll(s);
    discard(s, 2, '9s'); // 西家打 9 條：南家、北家都能胡了
    if (s.phase.kind !== 'claims') throw new Error('expected claims');
    expect(s.phase.options[1]?.hu).toBe(true);
    expect(s.phase.options[3]?.hu).toBe(true);
    assertConservation(s);
  });

  it('R08 碰過水：西家放過碰 6 筒，輪到自己之前不能再碰；輪到自己後解除', () => {
    const s = stackedGame({ ...TWO_WAITERS, E: '1p5p9p 1s3s5s9s EEE SSS WWW 6p', draws: '6p' });
    discard(s, 0, '6p');
    if (s.phase.kind !== 'claims') throw new Error('expected claims');
    expect(s.phase.options[2]?.pon).toBe(true);
    passAll(s);
    expect(s.players[2].passedPon).toEqual([parseKind('6p')]);
    // 南家摸到 6 筒打出：西家這巡不能碰，也沒有其他宣告 → 直接輪西家摸牌
    discard(s, 1, '6p');
    expect(s.phase).toMatchObject({ kind: 'turn', seat: 2 });
    expect(s.players[2].passedPon).toEqual([]);
  });

  it('加槓解除胡過水', () => {
    const s = stackedGame({ ...TWO_WAITERS, draws: '1s 2m 3p' });
    toWDiscards6s(s);
    passAll(s);
    expect(s.players[1].passedWin.length).toBeGreaterThan(0);
    // 直接模擬：南家有碰過的牌並摸到第四張時加槓（狀態層面驗證）
    s.players[1].melds.push({ type: 'pon', tiles: [parseKind('P') * 4, parseKind('P') * 4 + 1, parseKind('P') * 4 + 2] });
    const p = s.players[1];
    const extra = s.players[2].hand.findIndex((t) => kindOf(t) === parseKind('P'));
    p.hand.push(s.players[2].hand.splice(extra, 1)[0]);
    s.phase = { kind: 'turn', seat: 1, drew: null, kongDraw: false };
    apply(s, { type: 'kakan', seat: 1, kind: parseKind('P') });
    expect(s.players[1].passedWin).toEqual([]);
  });

  it('吃牌擺法：吃進來的那張擺在中間', () => {
    const s = stackedGame(TWO_WAITERS);
    toWDiscards6s(s);
    apply(s, { type: 'claim', seat: 1, choice: 'pass' });
    apply(s, { type: 'claim', seat: 3, choice: 'chi', chi: [parseKind('7s'), parseKind('8s')] });
    const meld = s.players[3].melds[0];
    expect(meld.tiles.map((t) => tileName(kindOf(t)))).toEqual(['七條', '六條', '八條']);
    assertConservation(s);
  });

  it('R05 胡 > 碰 > 吃：北家選吃、東家選碰、南家選胡，結果南家胡', () => {
    const s = stackedGame({
      ...TWO_WAITERS,
      E: '1p5p9p 1s3s 6s6s EEE SSS WWW C',
    });
    toWDiscards6s(s);
    if (s.phase.kind !== 'claims') throw new Error('expected claims');
    expect(s.phase.options[0]?.pon).toBe(true);
    expect(s.phase.options[3]?.chi.length).toBeGreaterThan(0);
    apply(s, { type: 'claim', seat: 3, choice: 'chi', chi: s.phase.options[3]!.chi[0] });
    apply(s, { type: 'claim', seat: 0, choice: 'pon' });
    apply(s, { type: 'claim', seat: 1, choice: 'hu' });
    expect(resultOf(s).wins.map((w) => w.seat)).toEqual([1]);
    // 北家有胡卻選吃：記過水
    expect(s.players[3].passedWin).toContain(parseKind('6s'));
  });

  it('X02 暗槓不能被搶槓', () => {
    const s = stackedGame({
      E: '1p5p9p 1s3s5s EEEE SSS WWW C',
      S: '123m456m789m234p78sNN',
      W: '6s 1p5p9p 3s5s9s FFF PPP 66p 5m',
      N: '123m456m789m234p567sC',
      back: '9m',
    });
    // 北家單吊東風也不行：暗槓後直接補牌
    apply(s, { type: 'ankan', seat: 0, kind: parseKind('E') });
    expect(s.phase).toMatchObject({ kind: 'turn', seat: 0, kongDraw: true });
    assertConservation(s);
  });

  it('搶槓：南家加槓 2 條，北家聽 2 條搶槓胡，加槓還原成碰', () => {
    const s = stackedGame({
      E: '1p5p9p 1s 2s 9s EEE SSS WWW CC',
      S: '2s2s 123m456m 789p 456p FF',
      W: '6s 1p5p9p 3s5s9s CC PPP 66p 5m 7m',
      N: '123m456m789m 13s NN 4p4p4p',
      draws: '9m 1p 5s 2s',
    });
    discard(s, 0, '2s');
    if (s.phase.kind !== 'claims') throw new Error('expected claims');
    expect(s.phase.options[3]?.hu).toBe(true);
    apply(s, { type: 'claim', seat: 3, choice: 'pass' }); // 北家放過（過水）
    apply(s, { type: 'claim', seat: 1, choice: 'pon' });
    expect(s.phase).toMatchObject({ kind: 'turn', seat: 1, drew: null });
    discard(s, 1, 'F');
    passAll(s);
    discard(s, 2, '9m');
    passAll(s);
    discard(s, 3, '1p'); // 北家摸過牌，過水解除
    passAll(s);
    discard(s, 0, '5s');
    passAll(s);
    expect(s.phase).toMatchObject({ kind: 'turn', seat: 1 });
    expect(turnOptions(s, 1)!.kakan).toEqual([parseKind('2s')]);
    apply(s, { type: 'kakan', seat: 1, kind: parseKind('2s') });
    if (s.phase.kind !== 'claims') throw new Error('expected rob-kong window');
    expect(s.phase.robKong).toBe(true);
    expect(Object.keys(s.phase.options)).toEqual(['3']);
    apply(s, { type: 'claim', seat: 3, choice: 'hu' });
    const win = resultOf(s).wins[0];
    expect(win.seat).toBe(3);
    expect(win.score.items.map((i) => i.name).sort()).toEqual(['搶槓', '獨聽', '門清'].sort());
    expect(s.scores).toEqual([0, -60, 0, 60]);
    expect(s.players[1].melds[0].type).toBe('pon');
    assertConservation(s);
  });

  it('R06 流局：大家都摸什麼打什麼、放過所有宣告，牌牆剩 16 張時流局，莊家連莊', () => {
    const s = newGame(DEFAULT_RULES, 42);
    for (let guard = 0; guard < 500 && s.phase.kind !== 'handOver'; guard++) {
      if (s.phase.kind === 'claims') passAll(s);
      else if (s.phase.kind === 'flowers') apply(s, { type: 'flowerStep' });
      else if (s.phase.kind === 'turn') {
        const seat = s.phase.seat;
        const tile = s.phase.drew ?? s.players[seat].hand[0];
        apply(s, { type: 'discard', seat, tile });
      }
    }
    if (s.phase.kind !== 'handOver') throw new Error('expected handOver');
    // 若有人開局補花湊成八仙過海或七搶一，會有花牌收分，這裡的種子沒有
    expect(s.phase.result.type).toBe('draw');
    expect(remaining(s)).toBe(16);
    assertConservation(s);
    apply(s, { type: 'nextHand' });
    expect(s.dealer).toBe(0);
    expect(s.dealerStreak).toBe(1);
  });
});

describe('報聽、咪幾、天聽', () => {
  it('咪幾：前 8 張捨牌內報聽、沒人吃碰槓，胡牌時加 4 台', () => {
    const s = stackedGame(TWO_WAITERS);
    discard(s, 0, 'C');
    passAll(s);
    expect(turnOptions(s, 1)!.tingBonus).toBe('miji');
    apply(s, { type: 'discard', seat: 1, tile: s.players[1].hand.find((t) => kindOf(t) === parseKind('1s'))!, declare: true });
    expect(s.players[1].declared).toBe(true);
    expect(s.players[1].miji).toBe(true);
    passAll(s);
    // 報聽後不能打剛摸以外的牌、只能胡不能吃碰
    discard(s, 2, '6s');
    if (s.phase.kind !== 'claims') throw new Error('expected claims');
    expect(s.phase.options[1]).toEqual({ hu: true, kong: false, pon: false, chi: [] });
    apply(s, { type: 'claim', seat: 1, choice: 'hu' });
    apply(s, { type: 'claim', seat: 3, choice: 'pass' });
    const win = resultOf(s).wins[0];
    expect(win.seat).toBe(1);
    expect(win.score.items.map((i) => `${i.name}:${i.tai}`)).toContain('咪幾:4');
  });

  it('報聽後只能打出剛摸的牌', () => {
    const s = stackedGame({ ...TWO_WAITERS, draws: '1s 2m 3p 5p' });
    discard(s, 0, 'C');
    passAll(s);
    apply(s, { type: 'discard', seat: 1, tile: s.players[1].hand.find((t) => kindOf(t) === parseKind('1s'))!, declare: true });
    passAll(s);
    discard(s, 2, '5m');
    passAll(s);
    discard(s, 3, '3p');
    passAll(s);
    discard(s, 0, '1p');
    passAll(s);
    expect(s.phase).toMatchObject({ kind: 'turn', seat: 1 });
    const ph = s.phase as { drew: number };
    const other = s.players[1].hand.find((t) => t !== ph.drew)!;
    expect(() => apply(s, { type: 'discard', seat: 1, tile: other })).toThrow(IllegalAction);
    expect(turnOptions(s, 1)!.ankan).toEqual([]);
    apply(s, { type: 'discard', seat: 1, tile: ph.drew });
  });

  it('天聽：莊家打出第一張牌就報聽，胡牌時加 8 台（不另計咪幾）', () => {
    const s = stackedGame({ ...TWO_WAITERS, E: '123m456m789m234p78sEE C' });
    expect(turnOptions(s, 0)!.tingBonus).toBe('tianting');
    apply(s, { type: 'discard', seat: 0, tile: s.players[0].hand.find((t) => kindOf(t) === parseKind('C'))!, declare: true });
    expect(s.players[0].tianting).toBe(true);
    expect(s.players[0].miji).toBe(false);
  });

  it('有人吃碰槓之後報聽，沒有咪幾', () => {
    const s = stackedGame({ ...TWO_WAITERS, E: '1p5p9p 1s3s 6s6s EEE SSS WWW C' });
    discard(s, 0, 'C');
    passAll(s);
    discard(s, 1, '1s');
    passAll(s);
    discard(s, 2, '6s');
    apply(s, { type: 'claim', seat: 1, choice: 'pass' });
    apply(s, { type: 'claim', seat: 3, choice: 'pass' });
    apply(s, { type: 'claim', seat: 0, choice: 'pon' });
    expect(turnOptions(s, 0)!.tingBonus).toBeNull();
  });

  it('不聽牌不能報聽', () => {
    const s = stackedGame(TWO_WAITERS);
    expect(() => apply(s, { type: 'discard', seat: 0, tile: s.players[0].hand[0], declare: true })).toThrow(IllegalAction);
  });
});

describe('花牌（八仙過海、七搶一）', () => {
  const base = {
    W: '6s 1p5p9p 3s5s9s FFF PPP 66p 5m',
    N: '123m456m789m234p78sNN',
    E: '1p5p9p 1s3s5s9s EEE SSS WWW C',
  };
  it('G07 開局補花就湊齊八仙過海：當場向三家各收 8 台，照常開始打牌', () => {
    const s = stackedGame({ ...base, S: 'f1f2f3f4f5f6f7f8 123m456m NN' });
    expect(s.flowerBonus?.kind).toBe('eightImmortals');
    expect(s.scores).toEqual([-80, 240, -80, -80]);
    expect(s.players[1].hand.length).toBe(16);
    expect(s.phase).toMatchObject({ kind: 'turn', seat: 0 });
    assertConservation(s);
  });

  it('G04 豹子局八仙過海：每家付 16 台', () => {
    const s = stackedGame({ ...base, S: 'f1f2f3f4f5f6f7f8 123m456m NN' }, {}, [4, 4, 4]);
    expect(s.leopard).toBe(true);
    expect(s.scores).toEqual([-160, 480, -160, -160]);
  });

  it('G05 七搶一：只有兩家有花（7 張與 1 張），由 1 張的那家賠 8 台', () => {
    const s = stackedGame({ ...base, S: 'f1f2f3f4f5f6f7 123m456m CCC', W: 'f8 1p5p9p 3s5s9s FFF PPP 66p 5m' });
    expect(s.flowerBonus).toMatchObject({ kind: 'sevenRobOne', to: 1, from: 2 });
    expect(s.scores).toEqual([0, 80, -80, 0]);
  });

  it('G06 8 張花分在三家不成立', () => {
    const s = stackedGame({
      ...base,
      S: 'f1f2f3f4f5f6 123m456m 789p 2s',
      W: 'f7 6s 1p5p9p 3s5s9s FFF PP 66p 5m',
      N: 'f8 123m456m789m234p78sN',
    });
    expect(s.flowerBonus).toBeUndefined();
    expect(s.scores).toEqual([0, 0, 0, 0]);
  });
});

describe('隨機對局模擬', () => {
  it('150 場 × 最多 20 局隨機合法動作：牌數守恆、分數總和為零、狀態可序列化', () => {
    const rng = createRng(7);
    const pick = <T,>(arr: T[]) => arr[Math.floor(rng() * arr.length)];
    let wins = 0;
    let draws = 0;
    for (let game = 0; game < 150; game++) {
      const s = newGame({ ...DEFAULT_RULES, rounds: 4, multiWin: game % 2 === 0 }, 1000 + game);
      let hands = 0;
      for (let step = 0; step < 400000 && s.phase.kind !== 'matchOver' && hands < 20; step++) {
        const ph = s.phase;
        if (ph.kind === 'handOver') {
          ph.result.type === 'win' ? wins++ : draws++;
          hands++;
          assertConservation(s);
          expect(s.scores.reduce((a, b) => a + b, 0)).toBe(0);
          // 莊家台：每位付款人付的錢 = (底 + (牌型台 + 莊家台) × 每台) × 倍數（豹子整筆加倍）
          const rs = s.rules.score;
          const mult = s.leopard && rs.leopardDouble ? 2 : 1;
          for (const w of ph.result.wins) {
            const payers = w.from === undefined ? ([0, 1, 2, 3] as Wind[]).filter((x) => x !== w.seat) : [w.from];
            const heavenly = w.score.items.some((i) => i.key === 'heavenly');
            for (const p of payers) {
              const involved = !heavenly && (w.seat === s.dealer || p === s.dealer);
              const dt = involved ? rs.table.dealer + rs.table.streak * s.dealerStreak : 0;
              expect(-w.deltas[p]).toBe((rs.base + (w.score.total + dt) * rs.perTai) * mult);
              if (involved) expect(w.dealerTai).toBe(dt);
            }
            expect(w.dealerOnly).toBe(w.from === undefined && w.seat !== s.dealer);
          }
          // 計分總表：最後一列的累計等於目前總分，各局變化加起來也等於總分
          expect(s.history[s.history.length - 1].totals).toEqual(s.scores);
          const sum = s.history.reduce((acc, h) => acc.map((x, i) => x + h.deltas[i]), [0, 0, 0, 0]);
          expect(sum).toEqual(s.scores);
          apply(s, { type: 'nextHand' });
        } else if (ph.kind === 'flowers') {
          apply(s, { type: 'flowerStep' });
        } else if (ph.kind === 'turn') {
          const o = turnOptions(s, ph.seat)!;
          if (o.canTsumo && rng() < 0.9) apply(s, { type: 'tsumo', seat: ph.seat });
          else if (o.ankan.length && rng() < 0.5) apply(s, { type: 'ankan', seat: ph.seat, kind: o.ankan[0] });
          else if (o.kakan.length && rng() < 0.5) apply(s, { type: 'kakan', seat: ph.seat, kind: o.kakan[0] });
          else {
            // 隨機打一張可以打的牌（吃牌後禁打的牌除外）
            const ok = s.players[ph.seat].hand.filter((t) => !o.noDiscard.includes(kindOf(t)));
            apply(s, { type: 'discard', seat: ph.seat, tile: pick(ok) });
          }
        } else if (ph.kind === 'claims') {
          const seat = (Object.keys(ph.options).map(Number) as Wind[]).find((x) => !ph.responses[x])!;
          const o = ph.options[seat]!;
          const choices: { choice: 'hu' | 'kong' | 'pon' | 'chi' | 'pass'; chi?: [number, number] }[] = [{ choice: 'pass' }];
          if (o.hu) choices.push({ choice: 'hu' }, { choice: 'hu' }, { choice: 'hu' });
          if (o.kong) choices.push({ choice: 'kong' });
          if (o.pon) choices.push({ choice: 'pon' });
          for (const c of o.chi) choices.push({ choice: 'chi', chi: c });
          apply(s, { type: 'claim', seat, ...pick(choices) });
        }
        if (step % 50 === 0) {
          assertConservation(s);
          // 快照與恢復：JSON 來回一次不能改變狀態
          expect(JSON.parse(JSON.stringify(s))).toEqual(s);
          const v = viewFor(s, 1);
          expect(JSON.stringify(v)).not.toContain('"wall"');
        }
      }
    }
    expect(wins + draws).toBe(3000);
    expect(wins).toBeGreaterThan(5); // 隨機亂打很少胡；AI 完成後改用 AI 對打 10 萬局
  }, 60000);
});

import { parseTiles, tileName } from '../src/engine/tiles';
import { chiForbidden, kindOf } from '../src/engine/game';
import { isWinningShape } from '../src/engine/hand';
function resultOf(s: GameState) {
  const ph: GameState['phase'] = s.phase;
  if (ph.kind !== 'handOver' && ph.kind !== 'matchOver') throw new Error(`expected handOver, got ${ph.kind}`);
  return ph.result;
}
function parseKind(s: string) {
  return parseTiles(s)[0];
}

describe('骰子開門與配牌（規格書 3.2）', () => {
  it('開門：從莊家起算骰子點數，數到的那家為東', () => {
    expect(breakSeatOf(0, [1, 2, 2])).toBe(0); // 5 點 → 莊家
    expect(breakSeatOf(0, [1, 2, 3])).toBe(1); // 6 點 → 下家
    expect(breakSeatOf(0, [2, 2, 3])).toBe(2); // 7 點 → 對家
    expect(breakSeatOf(2, [1, 1, 2])).toBe(1); // 莊家西、4 點 → 西的上家（南）
  });

  it('抓牌順序對應牌牆：開門那道從右數過點數，缺口左側開始抓，牌尾在缺口右側', () => {
    // 開門在座位 1、點數 6：第一墩是座位 1 從右數第 7 墩（索引 6）
    expect(stackPosition(1, 6, 0)).toEqual({ seat: 1, fromRight: 6 });
    // 抓完這道牌牆（剩 12 墩）後接上家（座位 0）
    expect(stackPosition(1, 6, 12)).toEqual({ seat: 0, fromRight: 0 });
    // 最後一墩（牌尾）是開門那道從右數第 6 墩
    expect(stackPosition(1, 6, 71)).toEqual({ seat: 1, fromRight: 5 });
    expect(stackCount(0, 0, 144)).toBe(2);
    expect(stackCount(0, 1, 144)).toBe(1);
    expect(stackCount(71, 0, 143)).toBe(1);
  });

  it('配牌：每人每次抓 4 張輪 4 次，莊家最後跳 1 張', () => {
    const wall = Array.from({ length: 144 }, (_, i) => i);
    const s = newGame(DEFAULT_RULES, 1, { wall, dice: [1, 2, 2] });
    // 沒有花牌落在配牌範圍（花牌是 136–143），可直接比對
    expect([...s.players[0].hand].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 16, 17, 18, 19, 32, 33, 34, 35, 48, 49, 50, 51, 64]);
    expect(s.players[1].hand.slice(0, 4)).toEqual([4, 5, 6, 7]);
    expect(s.players[3].hand).toContain(63);
    expect(s.wallHead).toBe(65);
  });

  it('正花與門風跟著開門那家走', () => {
    // 北家手上有春（1 花），補花從牌尾補到 8 條，聽 6、9 條
    const hands = { ...TWO_WAITERS, N: 'f1 123m456m789m234p7sNN', back: '8s' };
    const run = (dice: [number, number, number]) => {
      const s = stackedGame(hands, {}, dice);
      toWDiscards6s(s);
      apply(s, { type: 'claim', seat: 1, choice: 'pass' });
      apply(s, { type: 'claim', seat: 3, choice: 'hu' });
      if (s.phase.kind !== 'handOver') throw new Error('expected handOver');
      return { s, names: s.phase.result.wins[0].score.items.map((i) => i.name) };
    };
    const normal = run([1, 2, 2]); // 開門在莊家：北家是北
    expect(seatWindOf(normal.s, 3)).toBe(3);
    expect(normal.names.some((n) => n.startsWith('正花'))).toBe(false);
    const northBreak = run([1, 1, 2]); // 4 點開門在北家：北家是東、1 花
    expect(northBreak.s.breakSeat).toBe(3);
    expect(seatWindOf(northBreak.s, 3)).toBe(0);
    expect(seatWindOf(northBreak.s, 0)).toBe(1);
    expect(northBreak.names.some((n) => n.startsWith('正花'))).toBe(true);
    expect(viewFor(northBreak.s, 0).breakSeat).toBe(3);
  });
});

describe('吃牌後禁打（規格書 3.3）', () => {
  it('禁打的牌：吃邊張禁打吃進的那張與另一端；吃中間只禁打那張', () => {
    const m = (x: string) => parseTiles(x)[0];
    expect(chiForbidden(m('1m'), [m('2m'), m('3m')])).toEqual([m('1m'), m('4m')]);
    expect(chiForbidden(m('4p'), [m('2p'), m('3p')])).toEqual([m('4p'), m('1p')]);
    expect(chiForbidden(m('5s'), [m('4s'), m('6s')])).toEqual([m('5s')]);
    expect(chiForbidden(m('7m'), [m('8m'), m('9m')])).toEqual([m('7m')]); // 沒有十萬
  });

  it('二三四萬吃一萬：一萬、四萬這一手不能打，其他牌可以', () => {
    const s = stackedGame({
      E: '1m 1p5p9p 1s3s5s9s EEE SSS WWW',
      S: '234m 456p 789p 234s 55s N P',
      W: '6s 1p5p9p 3s5s9s FFF PPP 66p 5m',
      N: '123p456m789m234p78sNN',
    });
    discard(s, 0, '1m');
    if (s.phase.kind !== 'claims') throw new Error('expected claims');
    apply(s, { type: 'claim', seat: 1, choice: 'chi', chi: [parseKind('2m'), parseKind('3m')] });
    passAll(s);
    expect(s.phase).toMatchObject({ kind: 'turn', seat: 1 });
    expect(turnOptions(s, 1)!.noDiscard.sort()).toEqual([parseKind('1m'), parseKind('4m')].sort());
    expect(() => discard(s, 1, '4m')).toThrow(IllegalAction);
    discard(s, 1, 'N');
    assertConservation(s);
  });
});

describe('公開報聽只在咪幾、天聽', () => {
  it('過了咪幾的時機就不能公開報聽（改用自己知道的自動摸打）', () => {
    const s = stackedGame(TWO_WAITERS);
    discard(s, 0, 'C');
    passAll(s);
    s.discardCount = 8; // 模擬已經打過 8 張
    expect(turnOptions(s, 1)!.canDeclare).toBe(false);
    const t = s.players[1].hand.find((x) => kindOf(x) === parseKind('1s'))!;
    expect(() => apply(s, { type: 'discard', seat: 1, tile: t, declare: true })).toThrow(IllegalAction);
  });
});

describe('上家的牌不能直接明槓（規格書 3.3）', () => {
  const H = {
    E: '1p5p9p 1s3s5s9s EEE SSS WWW C',
    S: 'CCC 123m456m789m 2p NN W',
    W: '6s 1p5p9p 3s5s9s FFF PPP 66p 5m',
    N: '123p456m789m234p78sNN',
    draws: '2s 3s 4s 7m',
  };

  it('上家打出、自己有三張：不能槓只能碰；碰完這一手不能打同一張、不能加槓，下一輪才能補槓', () => {
    const s = stackedGame(H);
    discard(s, 0, 'C'); // 東家是南家的上家
    if (s.phase.kind !== 'claims') throw new Error('expected claims');
    expect(s.phase.options[1]).toMatchObject({ kong: false, pon: true });
    apply(s, { type: 'claim', seat: 1, choice: 'pon' });
    const o = turnOptions(s, 1)!;
    expect(o.kakan).toEqual([]);
    expect(o.noDiscard).toEqual([parseKind('C')]);
    expect(() => discard(s, 1, 'C')).toThrow(IllegalAction);
    discard(s, 1, 'W');
    passAll(s);
    for (const [seat, t] of [[2, '2s'], [3, '3s'], [0, '4s']] as const) {
      discard(s, seat, t);
      passAll(s);
    }
    // 下一輪：摸到七萬，現在可以補槓紅中
    expect(s.phase).toMatchObject({ kind: 'turn', seat: 1 });
    expect(turnOptions(s, 1)!.kakan).toEqual([parseKind('C')]);
    apply(s, { type: 'kakan', seat: 1, kind: parseKind('C') });
    assertConservation(s);
  });

  it('不是上家打的牌，照樣可以直接明槓', () => {
    const s = stackedGame({ ...H, E: '1p5p9p 1s3s5s9s EEE SSS WW 2p C', S: '123m456m789m 2p NN W W 3p 4p', N: 'CCC 456m789m234p78sNN' });
    discard(s, 0, 'C'); // 東家是北家的下家
    if (s.phase.kind !== 'claims') throw new Error('expected claims');
    expect(s.phase.options[3]).toMatchObject({ kong: true, pon: true });
  });
});

describe('大明槓補牌不能自摸（規格書 3.3）', () => {
  it('北家槓東家打的紅中，補上來的剛好是要胡的北風：不能自摸', () => {
    const s = stackedGame({
      E: '1p5p9p 1s3s5s9s EEE SSS WWW C',
      S: '123m 456m 789m 678p 99s F P',
      W: '6s 1p5p9p 3s5s9s FFF PPP 66p 5m',
      N: 'CCC 123m 456m 789m 234p N',
      back: 'N',
    });
    discard(s, 0, 'C');
    if (s.phase.kind !== 'claims') throw new Error('expected claims');
    expect(s.phase.options[3]?.kong).toBe(true);
    apply(s, { type: 'claim', seat: 3, choice: 'kong' });
    passAll(s);
    expect(s.phase).toMatchObject({ kind: 'turn', seat: 3, kongDraw: true });
    // 手牌確實已經胡了，只是大明槓補的牌不能自摸
    expect(isWinningShape(s.players[3].hand.map(kindOf), s.players[3].melds.length)).toBe(true);
    expect(turnOptions(s, 3)!.canTsumo).toBe(false);
    expect(() => apply(s, { type: 'tsumo', seat: 3 })).toThrow(IllegalAction);
    assertConservation(s);
  });
});

describe('開局補花一輪一輪補（規格書 3.2）', () => {
  it('莊家補到花要等其他人補完，下一輪才再補', () => {
    const s = stackedGame({
      E: 'f1 1p5p9p 1s3s5s9s EEE SSS WWW',
      S: 'f3 123m456m789m234p78sN',
      W: '6s 1p5p9p 3s5s9s FFF PPP 66p 5m',
      N: '123p456m789m234p78sNN',
      back: 'f2 4m 5m',
    });
    const order = s.events.filter((e) => e.t === 'flower').map((e) => (e as { seat: number }).seat);
    // 第一輪：東家（春）→ 南家（秋）；東家補到的夏留到第二輪
    expect(order).toEqual([0, 1, 0]);
    expect(s.players[0].flowers.length).toBe(2);
    expect(s.players[1].flowers.length).toBe(1);
    expect(s.players[0].hand.length).toBe(17);
    expect(s.players[1].hand.length).toBe(16);
    assertConservation(s);
  });
});

describe('宣告：優先順序最高的人選完就不用等其他人（規格書 3.3）', () => {
  it('北家（最近的能胡者）按胡：不用等東家碰、南家胡', () => {
    const s = stackedGame({ ...TWO_WAITERS, E: '1p5p9p 1s3s 6s6s EEE SSS WWW C' });
    toWDiscards6s(s);
    apply(s, { type: 'claim', seat: 3, choice: 'hu' });
    expect(resultOf(s).wins.map((w) => w.seat)).toEqual([3]);
  });

  it('南家先按胡：比他更靠近打牌者的北家也能胡，要等北家', () => {
    const s = stackedGame({ ...TWO_WAITERS, E: '1p5p9p 1s3s 6s6s EEE SSS WWW C' });
    toWDiscards6s(s);
    apply(s, { type: 'claim', seat: 1, choice: 'hu' });
    expect(s.phase.kind).toBe('claims');
  });

  const PON_CHI = { ...TWO_WAITERS, E: '1p5p5p9p 1s2s3s EEE SSS WWW C' };
  const toW5p = (s: GameState) => {
    discard(s, 0, 'C');
    passAll(s);
    discard(s, 1, '1s');
    passAll(s);
    discard(s, 2, '5p');
  };

  it('東家按碰：不用等下家北家決定要不要吃', () => {
    const s = stackedGame(PON_CHI);
    toW5p(s);
    if (s.phase.kind !== 'claims') throw new Error('expected claims');
    expect(s.phase.options[3]?.chi.length).toBeGreaterThan(0);
    expect(s.phase.options[0]?.pon).toBe(true);
    apply(s, { type: 'claim', seat: 0, choice: 'pon' });
    expect(s.phase).toMatchObject({ kind: 'turn', seat: 0 });
  });

  it('北家先按吃：東家還能碰，要等東家', () => {
    const s = stackedGame(PON_CHI);
    toW5p(s);
    if (s.phase.kind !== 'claims') throw new Error('expected claims');
    apply(s, { type: 'claim', seat: 3, choice: 'chi', chi: s.phase.options[3]!.chi[0] });
    expect(s.phase.kind).toBe('claims');
    apply(s, { type: 'claim', seat: 0, choice: 'pass' });
    expect(s.phase).toMatchObject({ kind: 'turn', seat: 3 });
  });
});

describe('補花一步一步來（畫面看得到原本的牌）', () => {
  it('開局先停在原始配牌，花還在手上；推一步才亮花、補牌', () => {
    const wall = stackWall({
      E: 'f1 1p5p9p 1s3s5s9s EEE SSS WWW',
      S: '123m456m789m234p78sNN',
      W: '6s 1p5p9p 3s5s9s FFF PPP 66p 5m',
      N: '123m456m789m234p78sNN',
      back: '2s',
    });
    const s = newGame(DEFAULT_RULES, 1, { wall, dice: [1, 2, 2] });
    expect(s.phase).toMatchObject({ kind: 'flowers', seat: 0, opening: true });
    expect(s.players[0].hand.some((t) => kindOf(t) >= 34)).toBe(true);
    expect(viewFor(s, 1).phase).toMatchObject({ kind: 'flowers', seat: 0 });
    apply(s, { type: 'flowerStep' });
    expect(s.players[0].flowers.length).toBe(1);
    expect(s.phase).toMatchObject({ kind: 'turn', seat: 0 });
  });

  it('打牌中摸到花：先停著，推一步才補牌、輪到他出牌', () => {
    const s = stackedGame({ ...TWO_WAITERS, draws: 'f3' });
    apply(s, { type: 'discard', seat: 0, tile: s.players[0].hand.find((t) => kindOf(t) === parseKind('C'))! });
    if (s.phase.kind === 'claims') for (const seat of Object.keys(s.phase.options).map(Number) as Wind[]) apply(s, { type: 'claim', seat, choice: 'pass' });
    expect(s.phase).toMatchObject({ kind: 'flowers', seat: 1, opening: false });
    apply(s, { type: 'flowerStep' });
    expect(s.phase).toMatchObject({ kind: 'turn', seat: 1 });
    expect(s.players[1].flowers.length).toBe(1);
    assertConservation(s);
  });
});
