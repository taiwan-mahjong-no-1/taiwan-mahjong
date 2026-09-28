/**
 * 牌桌控制器：持有 GameState，安排 AI 動作與思考時間。
 * 單人模式直接使用；開房模式由房主瀏覽器使用，遠端玩家的動作經網路送進 act()。
 */
import { AiLevel, decide } from '../ai/ai';
import { Action, apply, GameRules, GameState, IllegalAction, kindOf, newGame, PlayerView, turnOptions, viewFor } from '../engine/game';
import { waits } from '../engine/hand';
import { createRng, randomSeed, Rng } from '../engine/rng';
import { Wind } from '../engine/tiles';

export interface SeatInfo {
  name: string;
  kind: 'human' | 'ai' | 'remote';
  level?: AiLevel;
}

export interface TimerRules {
  /** 出牌思考秒數；0 = 不限時 */
  discardSeconds: number;
  /** 吃碰槓胡宣告秒數；0 = 不限時 */
  claimSeconds: number;
  /** 真人座位由 AI 代打時的強度（預設困難） */
  autoLevel?: AiLevel;
}

export interface TableView extends PlayerView {
  seats: SeatInfo[];
  /** 這個座位目前動作的截止時間（毫秒時間戳），沒有則為 null */
  deadline: number | null;
  paused: boolean;
  /** 這個座位目前由 AI 代打 */
  autoPlay: boolean;
  /** 所有目前由 AI 代打的真人座位（斷線或連續逾時） */
  autoSeats: Wind[];
  /** 自己開了「聽牌自動摸打」（只有自己知道，別人看不到） */
  autoTing: boolean;
}

type Listener = () => void;

const AI_DELAY: [number, number] = [800, 1500];

export class TableController {
  state: GameState;
  paused = false;
  private rng: Rng;
  private timers = new Map<Wind, ReturnType<typeof setTimeout>>();
  private deadlines = new Map<Wind, number>();
  private listeners = new Set<Listener>();
  /** 連續逾時次數（規格書 4.2：連續 3 次改由 AI 代打） */
  private timeouts = new Map<Wind, number>();
  autoPlay = new Set<Wind>();
  /** 聽牌自動摸打：座位 → 開啟時的局數（換局自動關閉） */
  private autoTing = new Map<Wind, number>();

  constructor(
    public rules: GameRules,
    public seats: SeatInfo[],
    public timer: TimerRules,
    seed = randomSeed(),
    public aiDelay: [number, number] = AI_DELAY,
    /** 從快照恢復（房主重開分頁） */
    initial?: GameState,
  ) {
    this.state = initial ?? newGame(rules, seed);
    this.rng = createRng(seed ^ 0x5bd1e995);
    queueMicrotask(() => this.schedule());
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  viewFor(seat: Wind): TableView {
    return {
      ...viewFor(this.state, seat),
      seats: this.seats,
      deadline: this.deadlines.get(seat) ?? null,
      paused: this.paused,
      autoPlay: this.autoPlay.has(seat),
      autoSeats: [...this.autoPlay],
      autoTing: this.isAutoTing(seat),
    };
  }

  /** 真人或遠端玩家送來的動作；非法動作回傳錯誤訊息 */
  act(seat: Wind | null, a: Action): string | null {
    if (this.paused && a.type !== 'nextHand') return '遊戲已暫停';
    // 補花由控制器自己推進，玩家不能送
    if (a.type === 'flowerStep') return '補花會自動進行';
    if (a.type !== 'nextHand' && a.seat !== seat) return '不是你的座位';
    try {
      apply(this.state, a);
    } catch (e) {
      if (e instanceof IllegalAction) return e.message;
      throw e;
    }
    if (seat !== null) {
      this.timeouts.set(seat, 0);
      this.autoPlay.delete(seat);
      // 開著自動摸打卻自己打成沒聽牌：自動關掉，免得之後一直打掉摸到的牌
      if (a.type === 'discard' && this.isAutoTing(seat)) {
        const p = this.state.players[seat];
        const melds = p.melds.map((m) => ({ type: m.type, tiles: m.tiles.map(kindOf) }));
        if (!waits(p.hand.map(kindOf), melds).length) this.autoTing.delete(seat);
      }
    }
    this.changed();
    return null;
  }

  /** 聽牌自動摸打（規格書 3.12）：只有自己知道；摸到不能胡的牌自動打掉、能胡就自動胡，隨時可以關閉 */
  setAutoTing(seat: Wind, on: boolean) {
    const had = this.isAutoTing(seat);
    if (on) this.autoTing.set(seat, this.state.handNo);
    else this.autoTing.delete(seat);
    if (had !== this.isAutoTing(seat)) this.changed();
  }

  isAutoTing(seat: Wind): boolean {
    return this.autoTing.get(seat) === this.state.handNo;
  }

  /** 玩家回來操作，取消 AI 代打 */
  takeBack(seat: Wind) {
    this.timeouts.set(seat, 0);
    if (this.autoPlay.delete(seat)) this.changed();
  }

  /** 玩家斷線或回來：斷線期間由 AI 代打（規格書 4.2） */
  setAway(seat: Wind, away: boolean) {
    const had = this.autoPlay.has(seat);
    if (away) this.autoPlay.add(seat);
    else {
      this.autoPlay.delete(seat);
      this.timeouts.set(seat, 0);
    }
    if (had !== this.autoPlay.has(seat)) this.changed();
  }

  /** 旁觀者看到的畫面：以東家視角，但不顯示任何手牌 */
  spectatorView(): TableView {
    const v = this.viewFor(0);
    const phase = v.phase.kind === 'turn'
      ? { ...v.phase, drew: null, options: null }
      : v.phase.kind === 'claims' ? { ...v.phase, myOptions: null, responded: true } : v.phase;
    return {
      ...v, hand: [], phase, deadline: null, autoPlay: false, autoTing: false,
      players: v.players.map((p) => ({ ...p, melds: p.melds.map((m) => (m.type === 'ankan' && !v.revealedHands ? { ...m, tiles: m.tiles.map(() => -1) } : m)) })),
    };
  }

  setPaused(p: boolean) {
    this.paused = p;
    if (p) this.clearTimers();
    this.changed();
  }

  destroy() {
    this.clearTimers();
    this.listeners.clear();
  }

  private changed() {
    this.schedule();
    for (const fn of this.listeners) fn();
  }

  private clearTimers() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.deadlines.clear();
  }

  /** 誰現在需要動作 */
  private actors(): Wind[] {
    const ph = this.state.phase;
    if (ph.kind === 'turn') return [ph.seat];
    if (ph.kind === 'claims') {
      return (Object.keys(ph.options).map(Number) as Wind[]).filter((s) => !ph.responses[s]);
    }
    return [];
  }

  private schedule() {
    this.clearTimers();
    if (this.paused) return;
    const ph = this.state.phase;
    if (ph.kind === 'flowers') {
      // 補花一步一步來：開局第一步等配牌動畫播完，之後每步停一下讓大家看到亮花、補牌
      const scale = this.aiDelay[1] / AI_DELAY[1];
      const first = ph.opening && this.state.players.every((p) => p.flowers.length === 0);
      const delay = (first ? 2200 : 900) * scale;
      this.timers.set(ph.seat, setTimeout(() => {
        if (this.paused || this.state.phase.kind !== 'flowers') return;
        apply(this.state, { type: 'flowerStep' });
        this.changed();
      }, delay));
      return;
    }
    for (const seat of this.actors()) {
      const info = this.seats[seat];
      const declared = this.state.players[seat].declared;
      const autoTing = info.kind !== 'ai' && !this.autoPlay.has(seat) && !declared && this.isAutoTing(seat)
        ? this.autoTingAction(seat) : null;
      if (info.kind === 'ai' || this.autoPlay.has(seat) || declared || autoTing) {
        // 報聽或開了自動摸打的真人：自動摸打、見胡必胡，節奏稍快
        const [lo, hi] = info.kind !== 'ai' && (declared || autoTing) && !this.autoPlay.has(seat)
          ? [this.aiDelay[0] * 0.6, this.aiDelay[1] * 0.6] : this.aiDelay;
        const delay = lo + this.rng() * (hi - lo);
        this.timers.set(seat, setTimeout(() => (autoTing ? this.runAutoTing(seat) : this.runAi(seat)), delay));
      } else {
        const secs = this.state.phase.kind === 'turn' ? this.timer.discardSeconds : this.timer.claimSeconds;
        if (secs > 0) {
          this.deadlines.set(seat, Date.now() + secs * 1000);
          this.timers.set(seat, setTimeout(() => this.onTimeout(seat), secs * 1000));
        }
      }
    }
  }

  /** 自動摸打這一步要做什麼：能胡就胡；摸到的牌不能胡就打掉；別人打的牌不能胡就過。其他情況交給玩家 */
  private autoTingAction(seat: Wind): Action | null {
    const ph = this.state.phase;
    if (ph.kind === 'turn' && ph.seat === seat) {
      const o = turnOptions(this.state, seat);
      if (o?.canTsumo) return { type: 'tsumo', seat };
      if (ph.drew !== null && !o?.noDiscard.includes(kindOf(ph.drew))) return { type: 'discard', seat, tile: ph.drew };
      return null;
    }
    if (ph.kind === 'claims' && ph.options[seat] && !ph.responses[seat]) {
      return { type: 'claim', seat, choice: ph.options[seat]!.hu ? 'hu' : 'pass' };
    }
    return null;
  }

  private runAutoTing(seat: Wind) {
    const a = this.isAutoTing(seat) ? this.autoTingAction(seat) : null;
    if (!a) return this.schedule();
    apply(this.state, a);
    this.changed();
  }

  private runAi(seat: Wind) {
    // AI 座位用自己的難度；真人座位（代打、報聽後自動摸打）用房間設定的代打強度
    const level = this.seats[seat].level ?? this.timer.autoLevel ?? 'hard';
    const a = decide(viewFor(this.state, seat), level, this.rng);
    if (!a) return;
    apply(this.state, a);
    this.changed();
  }

  /** 逾時：出牌打出剛摸的牌，宣告視為「過」 */
  private onTimeout(seat: Wind) {
    const ph = this.state.phase;
    const n = (this.timeouts.get(seat) ?? 0) + 1;
    this.timeouts.set(seat, n);
    if (n >= 3) this.autoPlay.add(seat);
    // 逾時遇到能胡的牌：直接幫他胡，不當成放棄（放棄會進入胡過水）
    if (ph.kind === 'turn' && ph.seat === seat && turnOptions(this.state, seat)?.canTsumo) {
      apply(this.state, { type: 'tsumo', seat });
    } else if (ph.kind === 'claims' && ph.options[seat]?.hu) {
      apply(this.state, { type: 'claim', seat, choice: 'hu' });
    } else if (ph.kind === 'turn' && ph.seat === seat) {
      const hand = this.state.players[seat].hand;
      // 打剛摸的牌；吃碰後沒有摸牌時，打最後一張可以打的牌（避開吃牌後禁打的牌）
      const banned = turnOptions(this.state, seat)?.noDiscard ?? [];
      const allowed = hand.filter((t) => !banned.includes(kindOf(t)));
      const tile = ph.drew ?? allowed[allowed.length - 1] ?? hand[hand.length - 1];
      apply(this.state, { type: 'discard', seat, tile });
    } else if (ph.kind === 'claims') {
      apply(this.state, { type: 'claim', seat, choice: 'pass' });
    }
    this.changed();
  }
}
