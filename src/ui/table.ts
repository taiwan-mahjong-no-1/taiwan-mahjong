/**
 * 牌桌畫面（規格書 4.3）：自己在下、下家在右、對家在上、上家在左。
 * 每次狀態改變就整個重畫；手牌選取、宣告選單等畫面狀態放在 ui 物件裡。
 */
import { Action, kindOf, MeldState, PlayerView, TileId, WinRecord } from '../engine/game';
import { waits } from '../engine/hand';
import { flowerSeat, isFlower, PLAYABLE_KINDS, TileKind, tileName, Wind, WIND_NAMES } from '../engine/tiles';
import { TableView } from '../game/controller';
import { esc, kindHtml, setSkin, Skin, skinPickerHtml, standingSrcOf, tileHtml, uiSrc } from './tiles';
import { stackCount, stackPosition, STACKS_PER_WALL, TOTAL_STACKS } from '../engine/wall';
import { Advice, suggest } from '../ai/ai';
import { createRng } from '../engine/rng';
import { AssistLevel, loadAssist, saveAssist } from './assist';
import { announce, getVoice, preloadVoice, say, setVoice, unlockAudio, VOICE_PACKS, VoicePack, VoiceSnap, voiceSnap } from './voice';
import { canFullscreen, isFullscreen, isStandalone, toggleFullscreen } from './fullscreen';

export interface TableHandlers {
  act(a: Action): string | null;
  nextHand(): void;
  togglePause(): void;
  takeBack(): void;
  /** 聽牌自動摸打開關 */
  setAutoTing(on: boolean): void;
  leave(): void;
  restart(): void;
}

interface UiState {
  selected: TileId | null;
  chiMenu: boolean;
  /** 報聽模式：選一張打出後報聽 */
  tingMode: boolean;
  kongMenu: boolean;
  message: string | null;
  showRules: boolean;
  showSkin: boolean;
  showAssist: boolean;
  showVoice: boolean;
  showScores: boolean;
}

const rel = (seat: Wind, me: Wind) => ((seat - me + 4) % 4) as 0 | 1 | 2 | 3;
const POS = ['bottom', 'right', 'top', 'left'] as const;
/** 門風：開門那家為東（規格書 3.2） */
const seatWind = (v: PlayerView, seat: Wind) => ((seat - (v.breakSeat ?? v.dealer) + 4) % 4) as Wind;
const REL_NAMES = ['自己', '下家', '對家', '上家'];
/** 配牌動畫：每一步抓 4 張（最後莊家跳 1 張）的間隔 */
const DEAL_STEP_MS = 110;
const DEAL_STEPS = 17;

export class TableScreen {
  private ui: UiState = { selected: null, tingMode: false, chiMenu: false, kongMenu: false, message: null, showRules: false, showSkin: false, showScores: false, showAssist: false, showVoice: false };
  /** 上一個畫面：比較變化決定要念什麼語音 */
  private voicePrev: VoiceSnap | null = null;
  /** 補花動畫：這次補花剛補上來的牌（閃一下） */
  private freshTiles = new Set<TileId>();
  private lastHand = new Set<TileId>();
  /** 輔助模式：AI 建議（只在自己的畫面） */
  private assist: AssistLevel = loadAssist();
  private adviceCache: { key: string; advice: Advice | null } | null = null;
  private view!: TableView;
  private tick?: ReturnType<typeof setInterval>;
  private lastSeq = -1;
  /** 已看過開局的局數，避免重連或重畫時重播配牌動畫 */
  private seenHand = -1;
  private dealAnim: { start: number; timer: ReturnType<typeof setInterval> } | null = null;

  constructor(
    private root: HTMLElement,
    private h: TableHandlers,
    private opts: {
      tingHint: boolean; role?: 'solo' | 'host' | 'guest'; roomId?: string; spectator?: boolean;
      /** 房主是否允許輔助模式（AI 提示）；省略表示允許 */
      assistAllowed?: () => boolean;
      extra?: { label: string; onClick: () => void };
    },
  ) {
    root.addEventListener('click', (e) => this.onClick(e));
    // 語音音量滑桿（拖動時不重畫畫面）
    root.addEventListener('input', (e) => {
      const el = e.target as HTMLInputElement;
      if (el.dataset.voiceVolume !== undefined) setVoice({ ...getVoice(), volume: Number(el.value) / 100 });
    });
    root.addEventListener('change', (e) => {
      if ((e.target as HTMLInputElement).dataset.voiceVolume !== undefined) say(['m5']);
    });
    // 手機要使用者點過畫面才能出聲：第一次點擊時啟動音訊並預先載入語音
    root.addEventListener('pointerdown', () => {
      unlockAudio();
      preloadVoice();
    });
    this.tick = setInterval(() => this.updateTimer(), 250);
  }

  destroy() {
    clearInterval(this.tick);
    if (this.dealAnim) clearInterval(this.dealAnim.timer);
  }

  /** 新的一局剛開始時播放配牌動畫（只影響中央牌牆示意，不擋操作） */
  private maybeStartDealAnim(v: TableView) {
    if (v.handNo === this.seenHand) return;
    this.seenHand = v.handNo;
    const fresh = v.phase.kind === 'turn' && v.players.every((p) => p.discards.length === 0 && p.melds.length === 0);
    if (!fresh) return;
    if (this.dealAnim) clearInterval(this.dealAnim.timer);
    const timer = setInterval(() => {
      if (!this.dealAnim || this.dealProgress() >= DEAL_STEPS) {
        clearInterval(timer);
        this.dealAnim = null;
      }
      if (this.view) this.render(this.view);
    }, DEAL_STEP_MS);
    this.dealAnim = { start: Date.now(), timer };
  }

  /** 配牌動畫進行到第幾步（0–17）；沒有動畫時為 17 */
  private dealProgress() {
    if (!this.dealAnim) return DEAL_STEPS;
    return Math.min(DEAL_STEPS, Math.floor((Date.now() - this.dealAnim.start) / DEAL_STEP_MS));
  }

  render(view: TableView) {
    if (view.seq !== this.lastSeq) {
      this.lastSeq = view.seq;
      say(announce(this.voicePrev, view));
      // 自己剛補完花：新補上來的牌閃一下（換局時不標）
      const prevFlowers = this.voicePrev?.seats[view.seat]?.flowers ?? 0;
      const flowered = !!this.voicePrev && this.voicePrev.handNo === view.handNo && view.players[view.seat].flowers.length > prevFlowers;
      this.freshTiles = flowered ? new Set(view.hand.filter((t) => !this.lastHand.has(t))) : new Set();
      // 動畫只播一次：之後重畫畫面時不再閃
      if (this.freshTiles.size) {
        const shown = this.freshTiles;
        setTimeout(() => { if (this.freshTiles === shown) this.freshTiles = new Set(); }, 700);
      }
      this.lastHand = new Set(view.hand);
      this.voicePrev = voiceSnap(view);
      this.ui.chiMenu = false;
      this.ui.kongMenu = false;
      this.ui.tingMode = false;
      if (this.ui.selected !== null && !view.hand.includes(this.ui.selected)) this.ui.selected = null;
    }
    this.view = view;
    this.maybeStartDealAnim(view);
    const v = view;
    const me = v.seat;
    const parts: string[] = [];
    parts.push(`<div class="table">`);
    for (let seat = 0; seat < 4; seat++) {
      const r = rel(seat as Wind, me);
      if (r === 0) continue;
      parts.push(this.opponentHtml(seat as Wind, POS[r]));
    }
    for (let seat = 0; seat < 4; seat++) parts.push(this.discardsHtml(seat as Wind, POS[rel(seat as Wind, me)]));
    parts.push(this.centerHtml());
    parts.push(this.myAreaHtml());
    parts.push(this.topBarHtml());
    if (v.phase.kind === 'handOver' || v.phase.kind === 'matchOver') parts.push(this.resultHtml());
    if (this.ui.showRules) parts.push(rulesDialog());
    if (this.ui.showScores) {
      parts.push(`<div class="overlay" data-act="closescores"><div class="dialog scores-dialog" data-act="noop">
        <h2>計分總表</h2>${this.scoreTableHtml()}
        <p class="muted small">分數一局一局累計，一圈（或一將）打完才結算。</p>
        <div class="dialog-buttons"><button class="btn" data-act="closescores">關閉</button></div></div></div>`);
    }
    if (this.ui.showVoice) {
      const vs = getVoice();
      parts.push(`<div class="overlay" data-act="closevoice"><div class="dialog small voice-dialog" data-act="noop">
        <h2>語音</h2>
        <p class="muted small">出牌念牌名，吃、碰、槓、聽、胡、自摸、補花也會念出來。只影響你自己的畫面。</p>
        <div class="seg"><button class="seg-btn${vs.on ? ' on' : ''}" data-act="voiceon:1">開</button><button class="seg-btn${vs.on ? '' : ' on'}" data-act="voiceon:0">關</button></div>
        <div class="voice-pack"><span>版本</span><div class="seg">${VOICE_PACKS.map((p) => `<button class="seg-btn${vs.pack === p.id ? ' on' : ''}" data-act="voicepack:${p.id}">${p.name}</button>`).join('')}</div></div>
        <label class="volume">音量 <input type="range" min="0" max="100" step="5" value="${Math.round(vs.volume * 100)}" data-voice-volume></label>
        <div class="dialog-buttons"><button class="btn" data-act="voicetest">試聽</button><button class="btn" data-act="closevoice">關閉</button></div></div></div>`);
    }
    if (this.ui.showAssist) {
      const opts: [AssistLevel, string][] = [['off', '關閉'], ['easy', '簡單'], ['normal', '普通'], ['hard', '困難']];
      parts.push(`<div class="overlay" data-act="closeassist"><div class="dialog small assist-dialog" data-act="noop">
        <h2>輔助模式</h2>
        <p class="muted small">讓 AI 建議打哪一張、要不要吃碰槓，並說明原因；最後還是由你決定。只有你看得到。</p>
        <div class="seg">${opts.map(([k, label]) => `<button class="seg-btn${this.assist === k ? ' on' : ''}" data-act="setassist:${k}">${label}</button>`).join('')}</div>
        <p class="muted small">建議的強度跟 AI 難度一樣：困難會算防守，普通偶爾沒算清楚，簡單比較隨性。</p>
        <div class="dialog-buttons"><button class="btn" data-act="closeassist">關閉</button></div></div></div>`);
    }
    if (this.ui.showSkin) {
      parts.push(`<div class="overlay" data-act="closeskin"><div class="dialog skin-dialog" data-act="noop">
        <h2>選擇風格</h2><p class="muted small">只會改變你自己的畫面，其他玩家不受影響。</p>${skinPickerHtml()}
        <div class="dialog-buttons"><button class="btn" data-act="closeskin">關閉</button></div></div></div>`);
    }
    if (v.paused && v.phase.kind !== 'handOver' && v.phase.kind !== 'matchOver') {
      parts.push(this.opts.role === 'guest'
        ? `<div class="overlay"><div class="dialog small"><h2>房主已暫停</h2><p>等房主按繼續</p></div></div>`
        : `<div class="overlay"><div class="dialog small"><h2>已暫停</h2><button class="btn primary" data-act="pause">繼續</button></div></div>`);
    }
    if (this.ui.message) parts.push(`<div class="toast">${esc(this.ui.message)}</div>`);
    parts.push(`</div>`);
    this.root.innerHTML = parts.join('');
    this.updateTimer();
  }

  // ---------------------------------------------------------------- 各區塊

  private nameTag(seat: Wind) {
    const v = this.view;
    const info = v.seats[seat];
    const dealer = seat === v.dealer ? `<span class="badge dealer">莊</span>` : '';
    const turn = ((v.phase.kind === 'turn' || v.phase.kind === 'flowers') && v.phase.seat === seat) ? ' active' : '';
    const score = v.scores[seat];
    return `<div class="nametag${turn}">
      <span class="wind">${WIND_NAMES[seatWind(v, seat)]}</span>${dealer}
      <span class="name">${esc(info.name)}</span>${v.players[seat]?.declared ? '<span class="badge-ting">聽</span>' : ''}${v.autoSeats?.includes(seat) && info.kind !== 'ai' ? '<span class="badge-auto">代打</span>' : ''}
      <span class="score ${score > 0 ? 'pos' : score < 0 ? 'neg' : ''}">${score > 0 ? '+' : ''}${score}</span>
    </div>`;
  }

  private meldsHtml(melds: MeldState[], cls = '') {
    return melds.map((m) => `<span class="meld ${cls}">${m.tiles.map((t) => tileHtml(t, 'm')).join('')}</span>`).join('');
  }

  private flowersHtml(flowers: TileId[], seat: Wind) {
    const v = this.view;
    return flowers.map((f) => tileHtml(f, flowerSeat(kindOf(f)) === seatWind(v, seat) ? 'f own' : 'f')).join('');
  }

  private opponentHtml(seat: Wind, pos: string) {
    const v = this.view;
    const p = v.players[seat];
    const over = v.revealedHands;
    const hand = over
      ? over[seat].map((t) => tileHtml(t, 'h')).join('')
      : Array.from({ length: p.handCount }, () => `<img class="tile h" src="${standingSrcOf()}" alt="" draggable="false">`).join('');
    return `<div class="opp opp-${pos}">
      ${this.nameTag(seat)}
      <div class="opp-row">
        <div class="opp-hand">${hand}</div>
        <div class="opp-melds">${this.meldsHtml(p.melds)}</div>
        <div class="opp-flowers">${this.flowersHtml(p.flowers, seat)}</div>
      </div>
    </div>`;
  }

  private discardsHtml(seat: Wind, pos: string) {
    const v = this.view;
    const p = v.players[seat];
    const ph = v.phase;
    const lastTile = ph.kind === 'claims' && ph.from === seat && !ph.robKong ? ph.tile : null;
    const side = pos === 'left' || pos === 'right';
    const tiles = p.discards.map((t) => {
      const img = tileHtml(t, `d${t === lastTile ? ' last' : ''}${t === p.declareTile ? ' declare' : ''}`);
      return side ? `<span class="rot">${img}</span>` : img;
    }).join('');
    return `<div class="discards discards-${pos}">${tiles}</div>`;
  }

  private centerHtml() {
    const v = this.view;
    const dice = v.dice.map((d) => `<img class="die" src="${uiSrc(`dice_${d}`)}" alt="${d} 點">`).join('');
    const streak = v.dealerStreak > 0 ? `<div class="streak">連莊 ${v.dealerStreak}</div>` : '';
    const leopard = v.leopard ? `<span class="leopard">豹子 ×2</span>` : '';
    const breakTotal = v.dice.reduce((a, b) => a + b, 0);
    const breakSeat = v.breakSeat ?? v.dealer;
    return `<div class="center">
      ${this.wallHtml()}
      <div class="round">${WIND_NAMES[v.roundWind]}風圈</div>
      <div class="remain">剩 <b>${v.wallRemaining}</b> 張</div>
      ${streak}
      <div class="dice">${dice}${leopard}</div>
      <div class="breakinfo">${this.dealAnim ? '配牌中…' : `${REL_NAMES[rel(breakSeat, v.seat)]}開門・${breakTotal} 墩`}</div>
    </div>`;
  }

  /**
   * 牌牆示意（規格書 3.2）：沿中央方框四邊畫出四家的牌牆，每道 18 墩。
   * 開門處畫缺口記號，下一張摸牌的那墩框金色，牌尾（補花）那墩框虛線。
   */
  private wallHtml() {
    const v = this.view;
    const breakSeat = v.breakSeat ?? v.dealer;
    const total = v.dice.reduce((a, b) => a + b, 0);
    const step = this.dealProgress();
    // 動畫中：牌頭依步數前進（每步 4 張，最後一步 1 張），牌尾等配牌完才開始補花
    const animHead = step >= DEAL_STEPS ? Infinity : step * 4;
    const head = Math.min(v.wallHead ?? 0, animHead);
    const tail = step >= DEAL_STEPS ? (v.wallTail ?? 144) : 144;
    const ANGLE = { bottom: 0, right: -90, top: 180, left: 90 } as const;
    const W = 80 / STACKS_PER_WALL; // 每墩佔的寬度（viewBox 0–100，四邊留 10）
    const groups: string[] = [];
    for (let seat = 0 as Wind; seat < 4; seat = (seat + 1) as Wind) {
      const rects: string[] = [];
      for (let j = 0; j < TOTAL_STACKS; j++) {
        const pos = stackPosition(breakSeat, total, j);
        if (pos.seat !== seat) continue;
        const n = stackCount(j, head, tail);
        const x = 90 - (pos.fromRight + 1) * W + 0.25;
        const mark = n > 0 && Math.floor(head / 2) === j ? ' head' : n > 0 && Math.floor((tail - 1) / 2) === j ? ' tail' : '';
        rects.push(`<rect class="ws ws${n}${mark}" x="${x.toFixed(2)}" y="91" width="${(W - 0.5).toFixed(2)}" height="6" rx="0.8"/>`);
      }
      if (seat === breakSeat) {
        // 開門缺口：開門那道牌牆從右數過點數的位置（點數 18 時在這道牌牆最左邊）
        const gx = 90 - Math.min(total, STACKS_PER_WALL) * W;
        rects.push(`<rect class="wbreak" x="${(gx - 0.45).toFixed(2)}" y="89.6" width="0.9" height="8.8" rx="0.3"/>`);
      }
      groups.push(`<g transform="rotate(${ANGLE[POS[rel(seat, v.seat)]]} 50 50)">${rects.join('')}</g>`);
    }
    return `<svg class="wall-ring" viewBox="0 0 100 100" aria-hidden="true">${groups.join('')}</svg>`;
  }

  private topBarHtml() {
    const v = this.view;
    return `<div class="topbar">
      <button class="icon-btn" data-act="leave" title="離開">✕</button>
      <button class="icon-btn" data-act="rules" title="規則">台數</button>
      <button class="icon-btn" data-act="skin" title="風格">風格</button>
      <button class="icon-btn${getVoice().on ? '' : ' off'}" data-act="voice" title="語音">語音</button>
      ${this.opts.spectator || !this.assistAllowed() ? '' : `<button class="icon-btn${this.assist !== 'off' ? ' on' : ''}" data-act="assist" title="輔助模式：AI 建議">提示</button>`}
      <button class="icon-btn" data-act="scores" title="計分總表">計分</button>
      ${this.opts.extra ? `<button class="icon-btn" data-act="extra">${esc(this.opts.extra.label)}</button>` : ''}
      ${canFullscreen() && !isStandalone() ? `<button class="icon-btn" data-act="fullscreen" title="全螢幕">${isFullscreen() ? '縮小' : '全螢幕'}</button>` : ''}
      ${this.opts.role === 'guest' ? '' : `<button class="icon-btn" data-act="pause" title="${v.paused ? '繼續' : '暫停'}">${v.paused ? '▶' : 'Ⅱ'}</button>`}
      <span class="handno">${this.opts.roomId ? `房號 ${esc(this.opts.roomId)}・` : ''}第 ${v.handNo + 1} 局${this.opts.spectator ? '・旁觀中' : ''}</span>
    </div>`;
  }

  private myAreaHtml() {
    const v = this.view;
    const me = v.seat;
    const p = v.players[me];
    const ph = v.phase;
    const myTurn = ph.kind === 'turn' && ph.seat === me;
    const drew = myTurn ? ph.drew : null;
    const over = !!v.revealedHands;
    const handTiles = over ? v.revealedHands![me] : v.hand;
    const sorted = handTiles.filter((t) => t !== drew).sort((a, b) => a - b);
    const declared = !!p.declared;
    const eligible = this.ui.tingMode ? new Set(this.tingDiscards()) : null;
    // 吃牌後這一手不能打的牌
    const banned = myTurn && ph.kind === 'turn' ? ph.options?.noDiscard ?? [] : [];
    const adv = this.advice();
    const sugTile = adv?.action.type === 'discard' ? adv.action.tile : null;
    const cls = (t: TileId) => {
      const isBanned = banned.includes(kindOf(t));
      const fresh = this.freshTiles.has(t) && !over ? ' fresh' : '';
      // 補花：手上的花先亮著給大家看，下一步才移到花牌區
      if (isFlower(kindOf(t))) return `h flower-in-hand${fresh}`;
      if (fresh) return `h fresh${myTurn && !declared && !isBanned ? ' playable' : ''}`;
      if (t === sugTile && t !== this.ui.selected) return ['h playable suggest'].join(' ');
      const ok = myTurn && !declared && !isBanned && (!eligible || eligible.has(kindOf(t)));
      return ['h', ok ? 'playable' : '', (eligible && !ok) || isBanned ? 'dim' : '', t === this.ui.selected ? 'selected' : ''].join(' ');
    };
    const handHtml = sorted.map((t) => tileHtml(t, cls(t), `data-tile="${t}"`)).join('');
    const drewHtml = drew !== null && !over ? `<span class="drew">${tileHtml(drew, cls(drew), `data-tile="${drew}"`)}</span>` : '';

    return `<div class="me">
      ${adv && adv.reason ? `<div class="advice-bar"><b>提示</b>${esc(adv.reason)}</div>` : ''}
      <div class="me-top">
        <div class="me-melds">${this.meldsHtml(p.melds)}${this.flowersHtml(p.flowers, me)}</div>
        <div class="ting">${this.passedHtml()}${this.tingHtml()}</div>
        <div class="actions">${this.actionsHtml()}</div>
      </div>
      <div class="me-hand">${handHtml}${drewHtml}</div>
      <div class="me-name">${this.nameTag(me)}</div>
    </div>`;
  }

  private assistAllowed(): boolean {
    return this.opts.assistAllowed?.() ?? true;
  }

  /** 輔助模式的建議（同一個局面只算一次） */
  private advice(): Advice | null {
    const v = this.view;
    if (this.assist === 'off' || !this.assistAllowed() || this.opts.spectator || v.revealedHands || v.autoPlay || v.autoTing || v.players[v.seat].declared) return null;
    const ph = v.phase;
    const mine = (ph.kind === 'turn' && ph.seat === v.seat && !!ph.options) || (ph.kind === 'claims' && !!ph.myOptions && !ph.responded);
    if (!mine) return null;
    const key = `${v.handNo}|${v.seq}|${ph.kind}|${this.assist}`;
    if (this.adviceCache?.key !== key) {
      const level = this.assist as Exclude<AssistLevel, 'off'>;
      this.adviceCache = { key, advice: suggest(v, level, createRng(v.seq * 7919 + v.seat)) };
    }
    return this.adviceCache.advice;
  }

  /** 建議對應到畫面上的哪個按鈕 */
  private adviceAct(a: Advice | null): string | null {
    if (!a) return null;
    const x = a.action;
    if (x.type === 'tsumo') return 'tsumo';
    if (x.type === 'ankan') return `ankan:${x.kind}`;
    if (x.type === 'kakan') return `kakan:${x.kind}`;
    if (x.type === 'claim') {
      if (x.choice === 'chi' && x.chi) return `chi:${x.chi[0]},${x.chi[1]}`;
      return `claim:${x.choice}`;
    }
    return null;
  }

  /** 過水提示：放過胡或碰之後，提醒哪些牌暫時不能胡、不能碰 */
  private passedHtml() {
    const v = this.view;
    if (v.revealedHands) return '';
    const parts: string[] = [];
    if (v.passedWin?.length) {
      parts.push(`<span class="passed" title="打出一張不在這組裡的牌，或加槓，才解除">過水・不能胡 ${v.passedWin.map((k) => kindHtml(k, 't')).join('')}</span>`);
    }
    if (v.passedPon?.length) {
      parts.push(`<span class="passed" title="輪到自己之後解除">這巡不能碰 ${v.passedPon.map((k) => kindHtml(k, 't')).join('')}</span>`);
    }
    return parts.join('');
  }

  /** 聽牌提示（規格書 FR-08）：選了要打的牌就顯示打出後聽什麼，否則顯示目前聽什麼 */
  private tingHtml() {
    const v = this.view;
    if (!this.opts.tingHint || v.revealedHands) return '';
    const me = v.players[v.seat];
    let hand = v.hand.map(kindOf);
    const sel = this.ui.selected;
    if (hand.length % 3 === 2) {
      if (sel === null) return '';
      hand = [...hand];
      hand.splice(hand.indexOf(kindOf(sel)), 1);
    }
    const melds = me.melds.map((m) => ({ type: m.type, tiles: m.tiles.filter((t) => t >= 0).map(kindOf) }));
    const w = waits(hand, melds);
    if (!w.length) return sel !== null ? `<span class="ting-none">打這張不會聽牌</span>` : '';
    const seen = new Array<number>(PLAYABLE_KINDS).fill(0);
    for (const k of hand) seen[k]++;
    for (const pl of v.players) {
      for (const t of pl.discards) seen[kindOf(t)]++;
      for (const m of pl.melds) for (const t of m.tiles) if (t >= 0) seen[kindOf(t)]++;
    }
    if (sel !== null) seen[kindOf(sel)]++;
    const items = w.map((k: TileKind) => `<span class="ting-item">${kindHtml(k, 't')}<small>剩 ${Math.max(0, 4 - seen[k])}</small></span>`).join('');
    return `<span class="ting-label">聽</span>${items}`;
  }

  private actionsHtml() {
    const v = this.view;
    const ph = v.phase;
    const me = v.seat;
    // 輔助模式建議的按鈕加上標示；吃有多種組合時先標在「吃」上
    const sug = this.adviceAct(this.advice());
    const isSug = (act: string) => act === sug || (act === 'chimenu' && !!sug?.startsWith('chi:'));
    const btn = (act: string, label: string, cls: string, extra = '') =>
      `<button class="act act-${cls}${isSug(act) ? ' suggest' : ''}" data-act="${act}" ${extra}>${label}</button>`;
    const timer = v.deadline ? `<span class="timer" data-deadline="${v.deadline}"></span>` : '';
    if (v.autoPlay) return `<span class="auto">AI 代打中</span>${btn('takeback', '我回來了', 'pass')}`;

    if (v.players[me].declared && !v.revealedHands) return `<span class="auto">已報聽・自動摸打，胡牌時自動胡</span>`;
    // 沒台的聽牌：只有自己知道的自動摸打，隨時可以關掉自己打、換聽
    const autoTing = v.autoTing && !v.revealedHands
      ? `<span class="auto" title="別人看不到">聽牌中・自動摸打</span>${btn('autoting:off', '關閉自動', 'pass')}` : '';
    if (ph.kind === 'turn' && ph.seat === me && ph.options) {
      const o = ph.options;
      const out: string[] = [];
      if (this.ui.tingMode) {
        const text = o.tingBonus === 'tianting' ? '選一張打出後報聽（天聽 8 台），再點一次確認'
          : o.tingBonus === 'miji' ? '選一張打出後報聽（咪幾 4 台），再點一次確認'
          : '選一張打出，之後自動摸打（只有你知道，隨時可關閉）';
        return `${timer}<span class="hint">${text}</span>${btn('tingcancel', '取消', 'pass')}`;
      }
      if (o.canTsumo) out.push(btn('tsumo', '自摸', 'hu'));
      if (!v.autoTing && this.tingDiscards().length) {
        out.push(btn('ting', o.canDeclare && o.tingBonus === 'tianting' ? '聽・天聽' : o.canDeclare && o.tingBonus === 'miji' ? '聽・咪幾' : '聽', 'ting'));
      }
      const kongs = [...o.ankan.map((k) => ['ankan', k] as const), ...o.kakan.map((k) => ['kakan', k] as const)];
      if (kongs.length === 1) out.push(btn(`${kongs[0][0]}:${kongs[0][1]}`, '槓', 'kan'));
      else if (kongs.length > 1) {
        out.push(this.ui.kongMenu
          ? kongs.map(([t, k]) => `<button class="act act-kan combo" data-act="${t}:${k}">${kindHtml(k, 'm')}</button>`).join('')
          : btn('kongmenu', '槓', 'kan'));
      }
      const bannedNote = o.noDiscard.length ? `<span class="hint">剛吃碰完，這一手不能打 ${o.noDiscard.map((k) => tileName(k)).join('、')}</span>` : '';
      if (!out.length) return `${timer}${autoTing}${bannedNote || (autoTing ? '' : '<span class="hint">點一下選牌，再點一次打出</span>')}`;
      return `${timer}${autoTing}${bannedNote}${out.join('')}`;
    }
    if (ph.kind === 'claims' && ph.myOptions && !ph.responded) {
      const o = ph.myOptions;
      const out: string[] = [];
      if (o.hu) out.push(btn('claim:hu', '胡', 'hu'));
      if (o.kong) out.push(btn('claim:kong', '槓', 'kan'));
      if (o.pon) out.push(btn('claim:pon', '碰', 'pon'));
      if (o.chi.length === 1) out.push(btn(`chi:${o.chi[0][0]},${o.chi[0][1]}`, '吃', 'chi'));
      else if (o.chi.length > 1) {
        const k = kindOf(ph.tile);
        out.push(this.ui.chiMenu
          ? o.chi.map(([a, b]) => {
              const seq = [a, b, k].sort((x, y) => x - y);
              return `<button class="act act-chi combo${isSug(`chi:${a},${b}`) ? ' suggest' : ''}" data-act="chi:${a},${b}">${seq.map((x) => kindHtml(x, 'm')).join('')}</button>`;
            }).join('')
          : btn('chimenu', '吃', 'chi'));
      }
      out.push(btn('claim:pass', '過', 'pass'));
      return `${timer}${autoTing}${out.join('')}`;
    }
    if (ph.kind === 'claims' && ph.myOptions && ph.responded) return `${autoTing}<span class="hint">等待其他玩家…</span>`;
    if (ph.kind === 'flowers') {
      return `<span class="hint">${ph.seat === me ? '補花中…' : `${esc(v.seats[ph.seat].name)} 補花中…`}</span>`;
    }
    return autoTing;
  }

  private resultHtml() {
    const v = this.view;
    const ph = v.phase;
    if (ph.kind !== 'handOver' && ph.kind !== 'matchOver') return '';
    const r = ph.result;
    const name = (s: Wind) => esc(v.seats[s].name);
    const blocks: string[] = [];
    if (r.flowerBonus) {
      const fb = r.flowerBonus;
      const title = fb.kind === 'eightImmortals' ? '八仙過海' : '七搶一';
      const who = fb.kind === 'eightImmortals' ? `${name(fb.to)} 向三家各收 8 台` : `${name(fb.from!)} 賠 8 台給 ${name(fb.to)}`;
      blocks.push(`<div class="res-flower"><b>${title}</b>　${who}</div>`);
    }
    if (r.type === 'draw') blocks.push(`<div class="res-title">流局</div><div class="res-sub">莊家連莊</div>`);
    for (const w of r.wins) blocks.push(this.winHtml(w));
    const order = ([0, 1, 2, 3] as Wind[]);
    const table = `<table class="res-table"><tr><th></th>${order.map((s) => `<th>${name(s)}</th>`).join('')}</tr>
      <tr><td>本局</td>${order.map((s) => `<td class="${r.deltas[s] > 0 ? 'pos' : r.deltas[s] < 0 ? 'neg' : ''}">${fmt(r.deltas[s])}</td>`).join('')}</tr>
      <tr><td>累計</td>${order.map((s) => `<td><b>${fmt(v.scores[s])}</b></td>`).join('')}</tr></table>`;
    let buttons: string;
    let rank = '';
    if (ph.kind === 'matchOver') {
      const ranking = [...order].sort((a, b) => v.scores[b] - v.scores[a]);
      rank = `<div class="final"><h2 class="final-title">牌局結束・總結算</h2>
        <div class="rank">${ranking.map((s, i) => `<div class="rank-row"><span>${i + 1}</span><span>${name(s)}</span><b class="${v.scores[s] > 0 ? 'pos' : v.scores[s] < 0 ? 'neg' : ''}">${fmt(v.scores[s])}</b></div>`).join('')}</div>
        <h3>每局分數</h3>${this.scoreTableHtml()}</div>`;
      buttons = this.opts.role === 'guest'
        ? `<p class="wait-host">等房主決定是否再來一將</p><button class="btn" data-act="leave">離開房間</button>`
        : this.opts.role === 'host'
          ? `<button class="btn primary" data-act="restart">再來一將</button><button class="btn" data-act="leave">結束房間</button>`
          : `<button class="btn primary" data-act="restart">再來一將</button><button class="btn" data-act="leave">回首頁</button>`;
    } else {
      buttons = (this.opts.role === 'guest'
        ? `<p class="wait-host">等房主按下一局…</p>`
        : `<button class="btn primary" data-act="next">下一局</button>`) +
        `<button class="btn" data-act="scores">計分總表</button>`;
    }
    return `<div class="overlay"><div class="dialog result">${blocks.join('')}${table}${rank}<div class="dialog-buttons">${buttons}</div></div></div>`;
  }

  /** 打出哪些牌後會聽牌（可以報聽的選擇） */
  private tingDiscards(): TileKind[] {
    const v = this.view;
    const me = v.players[v.seat];
    const kinds = v.hand.map(kindOf);
    if (kinds.length % 3 !== 2) return [];
    const melds = me.melds.map((m) => ({ type: m.type, tiles: m.tiles.filter((t) => t >= 0).map(kindOf) }));
    const out: TileKind[] = [];
    const banned = v.phase.kind === 'turn' ? v.phase.options?.noDiscard ?? [] : [];
    for (const k of new Set(kinds)) {
      if (banned.includes(k)) continue;
      const rest = [...kinds];
      rest.splice(rest.indexOf(k), 1);
      if (waits(rest, melds).length) out.push(k);
    }
    return out;
  }

  /** 計分總表：每一局的結果與四家分數變化，最下面是累計 */
  private scoreTableHtml() {
    const v = this.view;
    const name = (s: Wind) => esc(v.seats[s].name);
    const order = [0, 1, 2, 3] as Wind[];
    const NUM = '一二三四';
    const cell = (n: number) => `<td class="${n > 0 ? 'pos' : n < 0 ? 'neg' : 'zero'}">${n ? fmt(n) : '0'}</td>`;
    const rows = (v.history ?? []).map((h) => {
      const label = `${WIND_NAMES[h.roundWind]}${NUM[h.dealer]}局${h.dealerStreak ? `<small>連${h.dealerStreak}</small>` : ''}${h.leopard ? '<small class="lp">豹</small>' : ''}`;
      const res: string[] = [];
      if (h.flowerBonus) res.push(h.flowerBonus.kind === 'eightImmortals' ? `${name(h.flowerBonus.to)} 八仙過海` : `${name(h.flowerBonus.to)} 七搶一`);
      if (h.type === 'draw') res.push('流局');
      else {
        const from = h.wins[0].from;
        const who = h.wins.map((w) => {
          const dt = w.dealerTai ?? 0;
          const t = w.dealerOnly && dt ? `${w.tai} 台，莊家付 ${w.tai + dt} 台` : `${w.tai + dt} 台`;
          return `${name(w.seat)}（${t}）`;
        }).join('、');
        res.push(from === undefined ? `${who} 自摸` : `${who} 胡 ${name(from)}`);
      }
      return `<tr><td class="hl">${label}</td><td class="hr">${res.join('；')}</td>${order.map((s) => cell(h.deltas[s])).join('')}</tr>`;
    }).join('');
    const empty = `<tr><td colspan="6" class="muted">還沒有打完的局</td></tr>`;
    return `<div class="score-wrap"><table class="score-table">
      <thead><tr><th>局</th><th>結果</th>${order.map((s) => `<th>${name(s)}</th>`).join('')}</tr></thead>
      <tbody>${rows || empty}</tbody>
      <tfoot><tr><td colspan="2">累計</td>${order.map((s) => `<td class="${v.scores[s] > 0 ? 'pos' : v.scores[s] < 0 ? 'neg' : ''}"><b>${fmt(v.scores[s])}</b></td>`).join('')}</tr></tfoot>
    </table></div>`;
  }

  private winHtml(w: WinRecord) {
    const v = this.view;
    const hand = v.revealedHands![w.seat].filter((t) => t !== w.winTile).sort((a, b) => a - b);
    const how = w.from === undefined ? '自摸' : `胡 ${esc(v.seats[w.from].name)} 打出的牌`;
    const items = w.score.items.map((i) => `<span class="tai-item">${esc(i.name)} <b>${i.tai}</b></span>`);
    // 莊家台與連莊台（規格書 3.6）：莊家胡牌、莊家放槍、莊家自摸或閒家自摸（只有莊家付）時計
    const dt = w.dealerTai ?? 0;
    const note = w.dealerOnly ? '<small>莊家付</small>' : '';
    if (dt > 0) {
      items.push(`<span class="tai-item dealer">莊家 <b>1</b>${note}</span>`);
      if (v.dealerStreak > 0) items.push(`<span class="tai-item dealer">連${v.dealerStreak}拉${v.dealerStreak} <b>${dt - 1}</b>${note}</span>`);
    }
    const total = w.score.total + (w.dealerOnly ? 0 : dt);
    const totalHtml = w.dealerOnly && dt > 0
      ? `<span class="tai-total">共 ${w.score.total} 台</span><span class="tai-total alt">莊家付 ${w.score.total + dt} 台</span>`
      : `<span class="tai-total">共 ${total} 台</span>`;
    const leopard = v.leopard ? '<span class="tai-item lp">豹子局：（底 + 台）×2</span>' : '';
    const p = v.players[w.seat];
    return `<div class="res-win">
      <div class="res-title">${esc(v.seats[w.seat].name)}　${how}</div>
      <div class="res-hand">${hand.map((t) => tileHtml(t, 'r')).join('')}<span class="gap"></span>${this.meldsHtml(p.melds, 'r')}<span class="gap"></span>${tileHtml(w.winTile, 'r win')}</div>
      <div class="tai">${items.join('') || '<span class="tai-item">沒有台（只算底）</span>'}${totalHtml}${leopard}</div>
    </div>`;
  }

  // ---------------------------------------------------------------- 互動

  private updateTimer() {
    const el = this.root.querySelector<HTMLElement>('.timer');
    if (!el) return;
    const left = Math.max(0, Math.ceil((Number(el.dataset.deadline) - Date.now()) / 1000));
    el.textContent = String(left);
    el.classList.toggle('urgent', left <= 3);
  }

  private flash(msg: string) {
    this.ui.message = msg;
    this.render(this.view);
    setTimeout(() => {
      if (this.ui.message === msg) {
        this.ui.message = null;
        this.render(this.view);
      }
    }, 1800);
  }

  private onClick(e: Event) {
    const target = e.target as HTMLElement;
    const pick = target.closest<HTMLElement>('[data-pick-skin]');
    if (pick && this.view) {
      setSkin(pick.dataset.pickSkin as Skin);
      this.ui.showSkin = false;
      return this.render(this.view);
    }
    const tileEl = target.closest<HTMLElement>('[data-tile]');
    const actEl = target.closest<HTMLElement>('[data-act]');
    const v = this.view;
    if (!v) return;
    const me = v.seat;
    const send = (a: Action) => {
      const err = this.h.act(a);
      if (err) this.flash('現在不能這樣做');
      this.ui.selected = null;
    };
    if (tileEl && v.phase.kind === 'turn' && v.phase.seat === me && !v.revealedHands) {
      const t = Number(tileEl.dataset.tile);
      if (v.players[me].declared) return;
      if (this.ui.tingMode && !this.tingDiscards().includes(kindOf(t))) return;
      if (v.phase.options?.noDiscard.includes(kindOf(t))) {
        this.flash('剛吃碰進來的牌（吃牌時還有同一搭另一端的牌），這一手不能打');
        return;
      }
      if (this.ui.selected === t) {
        const o = v.phase.options;
        // 拿得到咪幾／天聽：公開報聽；沒台：打出後開啟只有自己知道的自動摸打
        const declare = this.ui.tingMode && !!o?.canDeclare;
        const auto = this.ui.tingMode && !declare;
        send({ type: 'discard', seat: me, tile: t, ...(declare ? { declare: true } : {}) });
        if (auto) this.h.setAutoTing(true);
        this.ui.tingMode = false;
      }
      else {
        this.ui.selected = t;
        this.render(v);
      }
      return;
    }
    if (!actEl) {
      if (this.ui.selected !== null) {
        this.ui.selected = null;
        this.render(v);
      }
      return;
    }
    const act = actEl.dataset.act!;
    const [cmd, arg] = act.split(':');
    switch (cmd) {
      case 'tsumo': return send({ type: 'tsumo', seat: me });
      case 'ankan': return send({ type: 'ankan', seat: me, kind: Number(arg) });
      case 'kakan': return send({ type: 'kakan', seat: me, kind: Number(arg) });
      case 'claim': return send({ type: 'claim', seat: me, choice: arg as 'hu' | 'kong' | 'pon' | 'pass' });
      case 'chi': {
        const [a, b] = arg.split(',').map(Number);
        return send({ type: 'claim', seat: me, choice: 'chi', chi: [a, b] });
      }
      case 'chimenu': this.ui.chiMenu = true; return this.render(v);
      case 'ting': this.ui.tingMode = true; this.ui.selected = null; return this.render(v);
      case 'autoting': return this.h.setAutoTing(false);
      case 'tingcancel': this.ui.tingMode = false; this.ui.selected = null; return this.render(v);
      case 'kongmenu': this.ui.kongMenu = true; return this.render(v);
      case 'next': return this.h.nextHand();
      case 'pause': return this.h.togglePause();
      case 'takeback': return this.h.takeBack();
      case 'leave': return this.h.leave();
      case 'restart': return this.h.restart();
      case 'rules': this.ui.showRules = true; return this.render(v);
      case 'skin': this.ui.showSkin = true; return this.render(v);
      case 'assist': this.ui.showAssist = true; return this.render(v);
      case 'voice': this.ui.showVoice = true; return this.render(v);
      case 'closevoice': this.ui.showVoice = false; return this.render(v);
      case 'voiceon':
        setVoice({ ...getVoice(), on: arg === '1' });
        if (arg === '1') say(['m1', 'pon']);
        return this.render(v);
      case 'voicepack':
        setVoice({ ...getVoice(), pack: arg as VoicePack });
        if (getVoice().on) say(['wind_e', 'pon', 'tsumo']);
        return this.render(v);
      case 'voicetest': return say(['wind_e', 'pon', 'tsumo']);
      case 'closeassist': this.ui.showAssist = false; return this.render(v);
      case 'setassist':
        this.assist = arg as AssistLevel;
        saveAssist(this.assist);
        this.adviceCache = null;
        return this.render(v);
      case 'scores': this.ui.showScores = true; return this.render(v);
      case 'closescores': this.ui.showScores = false; return this.render(v);
      case 'closeskin': this.ui.showSkin = false; return this.render(v);
      case 'extra': return this.opts.extra?.onClick();
      case 'fullscreen': return void toggleFullscreen().then(() => this.render(this.view));
      case 'closerules': this.ui.showRules = false; return this.render(v);
    }
  }
}

const fmt = (n: number) => (n > 0 ? `+${n}` : String(n));

export function rulesDialog(): string {
  const rows: [string, string][] = [
    ['莊家', '1'], ['連莊／拉莊', '每連 2'], ['門清', '1'], ['自摸', '1'], ['門清自摸', '3'],
    ['圈風刻、門風刻', '各 1'], ['三元牌刻', '每組 1'], ['正花', '每張 1'], ['花槓', '2'], ['獨聽', '1'],
    ['搶槓、槓上開花', '1'], ['海底撈月、河底撈魚', '1'], ['半求', '1'], ['全求', '2'], ['平胡', '2'],
    ['三暗刻', '2'], ['碰碰胡', '4'], ['混一色', '4'], ['小三元', '4'], ['四暗刻', '5'],
    ['清一色', '8'], ['大三元', '8'], ['小四喜', '8'], ['五暗刻', '8'], ['嚦咕嚦咕', '8'],
    ['八仙過海', '三家各付 8'], ['七搶一', '1 張花者付 8'], ['地胡', '16'], ['大四喜', '16'], ['字一色', '16'], ['天胡', '24'],
  ];
  return `<div class="overlay" data-act="closerules"><div class="dialog rules" data-act="noop">
    <h2>台數表</h2>
    <div class="rules-grid">${rows.map(([n, t]) => `<div>${n}</div><div>${t}</div>`).join('')}</div>
    <p class="rules-note">本局分數 = 底 + 總台數 × 每台分數；開局擲出豹子時（底 + 台）整筆加倍。門風與正花看骰子開門：開門那家為東（春梅），下家南（夏蘭）、再來西（秋竹）、北（冬菊）。過水：放過胡牌後，原本聽的整組牌別人打、自己摸都不能胡，要打出一張不在這組裡的牌或加槓才解除；放過碰牌後，到自己下一次輪到前不能再碰同一種牌。</p>
    <div class="dialog-buttons"><button class="btn primary" data-act="closerules">關閉</button></div>
  </div></div>`;
}
