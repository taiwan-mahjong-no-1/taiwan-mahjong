/**
 * 電腦玩家（規格書 4.1）。只看得到 PlayerView，跟真人一樣看不到別人的牌。
 *   簡單：打出使向聽數最小的牌，但有 30% 機率隨機打一張孤張；能吃就吃、能碰就碰、能槓就槓
 *   普通：向聽數最小，多數時候選有效進張最多的牌，但兩成時候隨便挑；能碰就碰、能槓就槓
 *   困難：向聽數最小、有效進張最多；吃碰要更接近聽牌才做；一律走最快胡的路線，不刻意做大台
 *     - 防守：有人報聽時兼顧安全，打報聽後他摸打掉的牌、現物、筋、場上出現多張的字牌
 *     - 棄胡：牌型太差或牌局進入中後段還離聽牌很遠時，改打最安全的牌、不再吃碰（見 foldLimit）
 * 所有難度見胡必胡；拿得到咪幾、天聽時一律報聽；遵守過水與吃牌後禁打（由規則引擎控管）。
 */
import { Action, chiForbidden, kindOf, PlayerView, TileId } from '../engine/game';
import { Rng } from '../engine/rng';
import { isHonor, PLAYABLE_KINDS, suitOf, TileKind, tileName } from '../engine/tiles';
import { shantenCounts } from './shanten';
import { waits } from '../engine/hand';

export type AiLevel = 'easy' | 'normal' | 'hard';

/** 普通 AI 不比進張、在一樣快的幾張裡隨便打的機率 */
const NORMAL_SLOPPY = 0.2;

const countsOf = (kinds: TileKind[]) => {
  const c = new Array<number>(PLAYABLE_KINDS).fill(0);
  for (const k of kinds) if (k < PLAYABLE_KINDS) c[k]++;
  return c;
};

/** 自己看得到的牌（手牌、所有捨牌、所有副露），用來估算每種牌還剩幾張 */
function visibleCounts(v: PlayerView): number[] {
  const c = countsOf(v.hand.map(kindOf));
  for (const p of v.players) {
    for (const t of p.discards) c[kindOf(t)]++;
    for (const m of p.melds) for (const t of m.tiles) if (t >= 0) c[kindOf(t)]++;
  }
  return c;
}

function ukeire(counts: number[], melds: number, visible: number[]): number {
  const base = shantenCounts(counts, melds);
  let total = 0;
  for (let k = 0; k < PLAYABLE_KINDS; k++) {
    const left = 4 - visible[k];
    if (left <= 0 || counts[k] >= 4) continue;
    counts[k]++;
    if (shantenCounts(counts, melds) < base) total += left;
    counts[k]--;
  }
  return total;
}

interface DiscardEval {
  kind: TileKind;
  shanten: number;
  ukeire: number;
  isolated: boolean;
}

function evalDiscards(v: PlayerView, meldCount: number, visible: number[]): DiscardEval[] {
  const counts = countsOf(v.hand.map(kindOf));
  const out: DiscardEval[] = [];
  // 吃牌後禁打的牌不列入考慮
  const banned = v.phase.kind === 'turn' ? v.phase.options?.noDiscard ?? [] : [];
  for (let k = 0; k < PLAYABLE_KINDS; k++) {
    if (!counts[k] || banned.includes(k)) continue;
    counts[k]--;
    const s = shantenCounts(counts, meldCount);
    const u = s <= 3 ? ukeire(counts, meldCount, visible) : 0;
    counts[k]++;
    const near = (d: number) => k < 27 && suitOf(k + d) === suitOf(k) && k + d >= 0 && counts[k + d] > 0;
    const isolated = counts[k] === 1 && (isHonor(k) || (!near(-1) && !near(1) && !near(-2) && !near(2)));
    out.push({ kind: k, shanten: s, ukeire: u, isolated });
  }
  return out;
}

/**
 * 他家的危險程度（權重）：已報聽 4，其他 1。
 * 只有報聽（確定聽牌）才讓困難 AI 轉為防守。模擬對打發現用副露數、牌局進度去「猜」誰聽牌，
 * 猜錯太多、棄掉太多還有機會的牌，得分反而比普通 AI 少很多（每局約少 3 分）。
 */
function dangerWeights(v: PlayerView): number[] {
  return v.players.map((p, seat) => (seat === v.seat ? 0 : p.declared ? 4 : 1));
}

/** 報聽之後才打出的牌（報聽後自動摸打，打出的一定不是他要的牌；能胡早就自摸了） */
function afterDeclare(p: PlayerView['players'][number]): TileKind[] {
  if (!p.declared || p.declareTile === null) return [];
  const i = p.discards.indexOf(p.declareTile);
  return i < 0 ? [] : p.discards.slice(i + 1).map(kindOf);
}

/**
 * 某張牌對某一家的安全度（0–12，越大越安全）：
 * 報聽後他摸打掉的牌最安全；他自己打過的（現物）次之；字牌看場上出現幾張；
 * 數字牌看筋（他打過隔三張的牌，兩面聽的機會較低）與是否為邊張。
 */
function safetyVs(k: TileKind, v: PlayerView, seat: number, visible: number[]): number {
  const p = v.players[seat];
  if (afterDeclare(p).includes(k)) return 12;
  if (p.discards.some((t) => kindOf(t) === k)) return 10;
  if (isHonor(k)) return visible[k] >= 3 ? 9 : visible[k] === 2 ? 6 : visible[k] === 1 ? 3 : 1;
  const r = k % 9; // 0 = 一、8 = 九
  const discarded = (d: number) => p.discards.some((t) => kindOf(t) === k + d);
  let sc = r === 0 || r === 8 ? 2 : r === 1 || r === 7 ? 1 : 0;
  const sujiLow = r >= 3 && discarded(-3);
  const sujiHigh = r <= 5 && discarded(3);
  // 一、九只要一邊有筋就算；中張兩邊都有筋才比較安全
  if ((r <= 2 && sujiHigh) || (r >= 6 && sujiLow)) sc += 3;
  else if (sujiLow && sujiHigh) sc += 3;
  else if (sujiLow || sujiHigh) sc += 1;
  if (visible[k] >= 3) sc += 2; // 剩最後一張，單吊、對碰的機會低
  return sc;
}

/** 對所有他家的加權安全度 */
function safety(k: TileKind, v: PlayerView, weights: number[], visible: number[]): number {
  let total = 0;
  weights.forEach((w, seat) => { if (w) total += w * safetyVs(k, v, seat, visible); });
  return total;
}

/**
 * 棄胡門檻（困難）：向聽數大於等於這個值就改成防守（打最安全的牌、不吃碰）。
 * 牌牆剩 71–79 張時開打，平均剩 42 張左右有人胡。統計開局向聽數 6 以上約佔 3%、胡牌率約 11%；
 * 向聽 5 約佔 15%、胡牌率約 15%（向聽 3 約 29%）。門檻依牌局進度：
 *   前段（剩 66 張以上）向聽 6 以上 → 牌型太差，一開始就防守
 *   剩 56–65 張 向聽 5 以上；剩 36–55 張（中段）向聽 4 以上；剩 35 張以下（後段）向聽 3 以上
 * 另外有人報聽而自己還差 3 步以上，或牌局尾聲（剩 20 張以下）有人報聽而自己沒聽牌，也棄胡。
 * 這些數字是用困難對普通各 8000 局的模擬調出來的：門檻再嚴一些（例如後段向聽 2 就棄胡），
 * 放槍更少但胡牌少更多，因為本遊戲底分大、自摸三家付，整體得分反而輸給普通 AI。
 */
export function foldLimit(wallRemaining: number): number {
  return wallRemaining > 65 ? 6 : wallRemaining > 55 ? 5 : wallRemaining > 35 ? 4 : 3;
  return wallRemaining > 65 ? 5 : wallRemaining > 55 ? 4 : wallRemaining > 35 ? 3 : 2;
}

function shouldFold(v: PlayerView, shanten: number, weights: number[]): boolean {
  if (shanten <= 0) return false;
  if (shanten >= foldLimit(v.wallRemaining)) return true;
  const declared = weights.some((w) => w >= 4);
  if (declared && shanten >= 3) return true;
  return declared && v.wallRemaining <= 20;
}

function chooseDiscard(v: PlayerView, level: AiLevel, rng: Rng): TileId {
  const me = v.players[v.seat];
  const visible = visibleCounts(v);
  const evals = evalDiscards(v, me.melds.length, visible);
  const minShanten = Math.min(...evals.map((e) => e.shanten));
  let pool = evals.filter((e) => e.shanten === minShanten);

  if (level === 'easy') {
    const isolated = evals.filter((e) => e.isolated);
    const pick = isolated.length && rng() < 0.3 ? isolated : pool;
    return tileOf(v, pick[Math.floor(rng() * pick.length)].kind);
  }

  // 普通：兩成的時候不比進張，在一樣快的幾張裡隨便打（像一般玩家偶爾沒算清楚）
  if (level === 'normal' && rng() < NORMAL_SLOPPY) return tileOf(v, pool[Math.floor(rng() * pool.length)].kind);

  let score = (e: DiscardEval) => e.ukeire * 10 + (e.isolated ? 3 : 0) + (isHonor(e.kind) ? 1 : 0);
  if (level === 'hard') {
    const counts = countsOf(v.hand.map(kindOf));
    const current = shantenCounts(counts, me.melds.length);
    const weights = dangerWeights(v);
    if (shouldFold(v, current, weights)) {
      // 棄胡：所有牌都可以打，挑對大家（依危險程度加權）最安全的；同分時保留牌型
      pool = evals;
      score = (e) => safety(e.kind, v, weights, visible) * 100 - e.shanten * 5 + e.ukeire * 0.1;
    } else {
      const declared = weights.some((w) => w >= 4);
      if (declared && minShanten >= 1) {
        // 還差一兩步但有人報聽：放寬到向聽數多 1 的選擇，兼顧安全
        pool = evals.filter((e) => e.shanten <= minShanten + 1);
        const attack = score;
        score = (e) => safety(e.kind, v, weights, visible) * 30 + attack(e) - (e.shanten - minShanten) * 500;
      }
    }
  }
  pool.sort((a, b) => score(b) - score(a));
  const top = pool.filter((e) => score(e) === score(pool[0]));
  return tileOf(v, top[Math.floor(rng() * top.length)].kind);
}

const tileOf = (v: PlayerView, k: TileKind): TileId => {
  // 同種牌打哪一張都一樣，打最後摸到的那張以外的
  const same = v.hand.filter((t) => kindOf(t) === k);
  return same[0];
};

/** 吃碰槓後的最佳向聽數（碰吃之後還要打一張） */
function shantenAfterCall(v: PlayerView, remove: TileKind[], meldsAfter: number, extraDiscard: boolean, banned: TileKind[] = []): number {
  const counts = countsOf(v.hand.map(kindOf));
  for (const k of remove) counts[k]--;
  if (!extraDiscard) return shantenCounts(counts, meldsAfter);
  let best = 99;
  for (let k = 0; k < PLAYABLE_KINDS; k++) {
    if (!counts[k] || banned.includes(k)) continue;
    counts[k]--;
    best = Math.min(best, shantenCounts(counts, meldsAfter));
    counts[k]++;
  }
  return best;
}

/**
 * AI 報聽：只有拿得到咪幾或天聽時才能公開報聽（規格書 3.12），這時一律報聽。
 */
function shouldDeclare(v: PlayerView, tile: TileId, bonus: boolean): boolean {
  if (!bonus) return false;
  const me = v.players[v.seat];
  const rest = v.hand.filter((t) => t !== tile).map(kindOf);
  const melds = me.melds.map((m) => ({ type: m.type, tiles: m.tiles.filter((t) => t >= 0).map(kindOf) }));
  return waits(rest, melds).length > 0;
}

export function decide(v: PlayerView, level: AiLevel, rng: Rng): Action | null {
  const ph = v.phase;
  const seat = v.seat;
  const me = v.players[seat];
  if (ph.kind === 'turn' && ph.seat === seat && ph.options) {
    const o = ph.options;
    if (o.canTsumo) return { type: 'tsumo', seat };
    // 已報聽：只能打出剛摸的牌
    if (o.declared) return { type: 'discard', seat, tile: ph.drew ?? v.hand[v.hand.length - 1] };
    const current = shantenCounts(countsOf(v.hand.map(kindOf)), me.melds.length) ;
    for (const k of o.ankan) {
      if (level !== 'hard' || shantenAfterCall(v, [k, k, k, k], me.melds.length + 1, true) <= current) {
        return { type: 'ankan', seat, kind: k };
      }
    }
    for (const k of o.kakan) {
      if (level !== 'hard' || shantenAfterCall(v, [k], me.melds.length, true) <= current) {
        return { type: 'kakan', seat, kind: k };
      }
    }
    const tile = chooseDiscard(v, level, rng);
    const declare = o.canDeclare && shouldDeclare(v, tile, o.tingBonus !== null);
    return { type: 'discard', seat, tile, ...(declare ? { declare: true } : {}) };
  }
  if (ph.kind === 'claims' && ph.myOptions && !ph.responded) {
    const o = ph.myOptions;
    const k = kindOf(ph.tile);
    if (o.hu) return { type: 'claim', seat, choice: 'hu' };
    const now = shantenCounts(countsOf(v.hand.map(kindOf)), me.melds.length);
    const n = me.melds.length + 1;
    // 困難：棄胡時不吃碰槓，保留手上的安全牌
    if (level === 'hard' && shouldFold(v, now, dangerWeights(v))) return { type: 'claim', seat, choice: 'pass' };
    if (o.kong) {
      const s = shantenAfterCall(v, [k, k, k], n, false);
      // 簡單、普通能槓就槓；困難槓了牌型不變差才槓
      if (level !== 'hard' || s <= now) return { type: 'claim', seat, choice: 'kong' };
    }
    if (o.pon) {
      // 碰上家的牌：這一手不能打同一張
      const s = shantenAfterCall(v, [k, k], n, true, (ph.from + 1) % 4 === seat ? [k] : []);
      // 簡單、普通能碰就碰；困難要更接近聽牌才碰
      if (level !== 'hard' || s < now) return { type: 'claim', seat, choice: 'pon' };
    }
    let bestChi: [TileKind, TileKind] | null = null;
    // 簡單：能吃就吃（有好幾種吃法時挑離聽牌最近的）
    let bestS = level === 'easy' ? Infinity : now;
    for (const pair of o.chi) {
      // 吃完不能馬上打吃進的那張與同一搭另一端的牌
      const s = shantenAfterCall(v, pair, n, true, chiForbidden(k, pair));
      if (s < bestS) { bestS = s; bestChi = pair; }
    }
    if (bestChi) return { type: 'claim', seat, choice: 'chi', chi: bestChi };
    return { type: 'claim', seat, choice: 'pass' };
  }
  return null;
}

// ---------------------------------------------------------------- 輔助模式：建議與原因

export interface Advice {
  action: Action;
  /** 給玩家看的簡短原因 */
  reason: string;
}

const q = (k: TileKind): string => `「${tileName(k)}」`;
const names = (ks: TileKind[]) => ks.map((k) => tileName(k)).join('、');

/** 為什麼這張比較安全（防守時的說明） */
function safetyReason(k: TileKind, v: PlayerView, visible: number[]): string {
  for (const [seat, p] of v.players.entries()) {
    if (seat === v.seat || !p.declared) continue;
    if (afterDeclare(p).includes(k)) return '報聽的人報聽後摸到又打掉過這張，一定不是他要的';
    if (p.discards.some((t) => kindOf(t) === k)) return '報聽的人自己打過這張（現物），比較安全';
  }
  if (isHonor(k) && visible[k] >= 3) return '這張字牌場上已經出現 3 張，幾乎不會放槍';
  if (v.players.every((p, seat) => seat === v.seat || p.discards.some((t) => kindOf(t) === k))) {
    return '其他三家都打過這張，很安全';
  }
  return '在手上的牌裡相對最安全';
}

/** 吃碰的原因：離聽牌變近、不變或變遠（簡單、普通能吃碰就吃碰） */
function callReason(what: string, now: number, after: number): string {
  if (after < now) return `${what}了離聽牌從 ${now} 步變 ${after} 步`;
  if (after === now) return `${what}了牌型不會變差，${after === 0 ? '可以聽牌' : `還差 ${after} 步`}`;
  return `這個難度能${what}就${what}（${what}了離聽牌會從 ${now} 步變 ${after} 步）`;
}

/**
 * 輔助模式：用指定難度的 AI 想一次，回傳建議的動作與原因（最後還是由玩家決定）。
 * 只用 PlayerView，看不到別人的牌。
 */
export function suggest(v: PlayerView, level: AiLevel, rng: Rng): Advice | null {
  const ph = v.phase;
  const me = v.players[v.seat];
  const action = decide(v, level, rng);
  if (!action) return null;
  const visible = visibleCounts(v);
  const counts = countsOf(v.hand.map(kindOf));
  const now = shantenCounts(counts, me.melds.length);

  if (ph.kind === 'turn') {
    if (action.type === 'tsumo') return { action, reason: '自摸了，胡吧！' };
    if (action.type === 'ankan' || action.type === 'kakan') {
      return { action, reason: `槓${q(action.kind)}：牌型不會變差，還能多摸一張` };
    }
    if (action.type !== 'discard') return { action, reason: '' };
    const k = kindOf(action.tile);
    counts[k]--;
    const after = shantenCounts(counts, me.melds.length);
    const declareNote = action.declare
      ? `，順便報聽拿${ph.options?.tingBonus === 'tianting' ? '天聽 8 台' : '咪幾 4 台'}` : '';
    if (level === 'hard' && shouldFold(v, now, dangerWeights(v))) {
      return { action, reason: `先防守：${now >= foldLimit(v.wallRemaining) ? '牌型離聽牌還很遠' : '有人報聽、自己還差好幾步'}，打${q(k)}——${safetyReason(k, v, visible)}` };
    }
    if (after === 0) {
      const melds = me.melds.map((m) => ({ type: m.type, tiles: m.tiles.filter((t) => t >= 0).map(kindOf) }));
      const rest = v.hand.filter((t) => t !== action.tile).map(kindOf);
      const w = waits(rest, melds);
      const left = w.reduce((n, x) => n + Math.max(0, 4 - visible[x]), 0);
      return { action, reason: `打${q(k)}就聽牌，聽 ${names(w)}（還剩 ${left} 張）${declareNote}` };
    }
    const u = ukeire(counts, me.melds.length, visible);
    return { action, reason: `打${q(k)}後離聽牌還差 ${after} 步，能讓牌前進的牌有 ${u} 張${declareNote}` };
  }

  if (ph.kind === 'claims' && ph.myOptions) {
    const o = ph.myOptions;
    const k = kindOf(ph.tile);
    const n = me.melds.length + 1;
    if (action.type !== 'claim') return null;
    if (action.choice === 'hu') return { action, reason: `胡${q(k)}！` };
    if (action.choice === 'kong') return { action, reason: `槓${q(k)}：牌型不會變差，還能多摸一張` };
    if (action.choice === 'pon') {
      const s = shantenAfterCall(v, [k, k], n, true);
      return { action, reason: callReason('碰', now, s) };
    }
    if (action.choice === 'chi' && action.chi) {
      const s = shantenAfterCall(v, action.chi, n, true, chiForbidden(k, action.chi));
      const seq = [...action.chi, k].sort((a, b) => a - b);
      return { action, reason: `吃成 ${names(seq)}：${callReason('吃', now, s)}` };
    }
    // 建議不吃碰
    if (level === 'hard' && shouldFold(v, now, dangerWeights(v))) return { action, reason: '正在防守，不吃碰，保留手上的安全牌' };
    if (o.pon || o.chi.length || o.kong) return { action, reason: `${o.pon ? '碰' : o.kong ? '槓' : '吃'}了離聽牌不會更近，不如留著手上的牌` };
    return { action, reason: '不能胡這張，過' };
  }
  return null;
}
