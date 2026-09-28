/**
 * 房主模組（規格書 5.1）：在房主的瀏覽器執行，管理座位、執行牌局、只把各家看得到的畫面傳給各家。
 */
import { AiLevel } from '../ai/ai';
import { Action, DEFAULT_RULES, GameRules, GameState } from '../engine/game';
import { DEFAULT_SCORE_RULES } from '../engine/settlement';
import { Wind } from '../engine/tiles';
import { SeatInfo, TableController, TableView } from '../game/controller';
import { LobbyState, Link, newToken, RoomSettings, ToClient, ToHost, You } from './protocol';

export interface Member {
  name: string;
  token: string;
  isHost: boolean;
  connected: boolean;
  spectator: boolean;
  seat: Wind | null;
  link?: Link<ToHost, ToClient>;
}

/** 房主重開分頁時用來恢復的快照（存在房主瀏覽器） */
export interface HostSnapshot {
  v: 1;
  roomId: string;
  savedAt: number;
  settings: RoomSettings;
  members: Omit<Member, 'link' | 'connected'>[];
  seats?: SeatInfo[];
  state?: GameState;
  /** 同 Wi-Fi 離線房間 */
  offline?: boolean;
}

export const MAX_PLAYERS = 4;
const AI_NAMES = ['阿土伯', '錢夫人', '大老李', '孫小美', '金貝貝', '烏咪'];
const LEVEL_NAME: Record<AiLevel, string> = { easy: '簡單', normal: '普通', hard: '困難' };

export function rulesFrom(s: RoomSettings): GameRules {
  return {
    ...DEFAULT_RULES,
    rounds: s.rounds,
    multiWin: s.multiWin,
    score: { ...DEFAULT_SCORE_RULES, base: s.base, perTai: s.perTai, leopardDouble: s.leopardDouble },
  };
}

export interface HostOptions {
  aiDelay?: [number, number];
  /** 每次狀態改變時存快照 */
  save?: (snap: HostSnapshot) => void;
  restore?: HostSnapshot;
  random?: () => number;
  offline?: boolean;
}

export class HostRoom {
  members: Member[] = [];
  ctl: TableController | null = null;
  private listeners = new Set<() => void>();
  private unsubCtl: (() => void) | null = null;
  private random: () => number;

  constructor(public roomId: string, public settings: RoomSettings, hostName: string, private opts: HostOptions = {}) {
    this.random = opts.random ?? Math.random;
    const r = opts.restore;
    if (r) {
      this.members = r.members.map((m) => ({ ...m, connected: m.isHost }));
      if (r.state && r.seats) this.startController(r.seats, r.state);
    } else {
      this.members.push({ name: hostName, token: newToken(), isHost: true, connected: true, spectator: false, seat: null });
    }
  }

  get host(): Member {
    return this.members.find((m) => m.isHost)!;
  }

  get players(): Member[] {
    return this.members.filter((m) => !m.spectator);
  }

  get started() {
    return this.ctl !== null;
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  lobby(): LobbyState {
    return {
      roomId: this.roomId,
      settings: this.settings,
      players: this.players.map((m) => ({ name: m.name, connected: m.connected, isHost: m.isHost })),
      started: this.started,
      spectators: this.members.filter((m) => m.spectator && m.connected).length,
    };
  }

  // ---------------------------------------------------------------- 連線

  accept(link: Link<ToHost, ToClient>) {
    let member: Member | null = null;
    link.onMessage((msg) => {
      if (msg.t === 'hello') member = this.onHello(link, msg.name, msg.token);
      else if (member) this.onMessage(member, msg);
    });
    link.onClose(() => {
      if (member && member.link === link) this.onLeave(member);
    });
  }

  private onHello(link: Link<ToHost, ToClient>, rawName: string, token?: string): Member {
    const name = cleanName(rawName, this.members);
    let m = token ? this.members.find((x) => x.token === token && !x.isHost) : undefined;
    if (m) {
      // 重連：同一個人回到原座位
      if (m.link && m.link !== link) m.link.close();
      m.link = link;
      m.connected = true;
      if (this.ctl && m.seat !== null) this.ctl.setAway(m.seat, false);
    } else {
      const spectator = this.started || this.players.length >= MAX_PLAYERS;
      m = { name, token: newToken(), isHost: false, connected: true, spectator, seat: null, link };
      this.members.push(m);
    }
    this.changed();
    return m;
  }

  private onMessage(m: Member, msg: ToHost) {
    if (msg.t === 'bye') {
      m.link?.close();
      this.onLeave(m);
      return;
    }
    if (!this.ctl || m.seat === null) return;
    if (msg.t === 'takeBack') {
      this.ctl.takeBack(m.seat);
      return;
    }
    if (msg.t === 'autoTing') {
      this.ctl.setAutoTing(m.seat, msg.on);
      return;
    }
    if (msg.t === 'action') {
      // 下一局、再來一將由房主決定
      if (msg.action.type === 'nextHand') return;
      const err = this.ctl.act(m.seat, msg.action);
      if (err) m.link?.send({ t: 'error', message: err });
    }
  }

  private onLeave(m: Member) {
    m.connected = false;
    m.link = undefined;
    if (!this.started && !m.isHost) {
      this.members = this.members.filter((x) => x !== m);
    } else if (this.ctl && m.seat !== null) {
      this.ctl.setAway(m.seat, true);
    }
    this.changed();
  }

  // ---------------------------------------------------------------- 房主操作

  /** 開始：擲骰決定座位（隨機），空位補 AI */
  start() {
    if (this.started) return;
    const players = this.players.filter((m) => m.connected);
    const seatsOrder = [0, 1, 2, 3].sort(() => this.random() - 0.5) as Wind[];
    const names = [...AI_NAMES].sort(() => this.random() - 0.5);
    const seats: SeatInfo[] = new Array(4);
    players.forEach((m, i) => {
      m.seat = seatsOrder[i];
      seats[m.seat] = { name: m.name, kind: m.isHost ? 'human' : 'remote' };
    });
    for (const s of seatsOrder.slice(players.length)) {
      seats[s] = { name: `${names.pop()}・${LEVEL_NAME[this.settings.level]}`, kind: 'ai', level: this.settings.level };
    }
    this.startController(seats);
  }

  /** 一將結束後「再來一將」：同樣的座位重新開始 */
  restart() {
    if (!this.ctl) return;
    const seats = this.ctl.seats;
    this.startController(seats);
  }

  hostAct(a: Action): string | null {
    if (!this.ctl) return '尚未開始';
    return this.ctl.act(a.type === 'nextHand' ? null : this.host.seat, a);
  }

  setPaused(p: boolean) {
    this.ctl?.setPaused(p);
  }

  close(reason = '房主已結束房間') {
    for (const m of this.members) {
      m.link?.send({ t: 'closed', reason });
      m.link?.close();
    }
    this.unsubCtl?.();
    this.ctl?.destroy();
    this.listeners.clear();
  }

  hostView(): TableView | null {
    const seat = this.host.seat;
    return this.ctl && seat !== null ? this.ctl.viewFor(seat) : null;
  }

  // ---------------------------------------------------------------- 內部

  private startController(seats: SeatInfo[], initial?: GameState) {
    this.unsubCtl?.();
    this.ctl?.destroy();
    const s = this.settings;
    const timer = { discardSeconds: s.discardSeconds, claimSeconds: s.claimSeconds ?? 8, autoLevel: s.autoLevel ?? 'hard' };
    this.ctl = new TableController(rulesFrom(s), seats, timer, undefined, this.opts.aiDelay, initial);
    // 還沒連回來的玩家先由 AI 代打
    for (const m of this.members) {
      if (m.seat !== null && !m.connected) this.ctl.setAway(m.seat, true);
    }
    this.unsubCtl = this.ctl.subscribe(() => this.changed());
    this.changed();
  }

  private changed() {
    this.broadcast();
    this.save();
    for (const fn of this.listeners) fn();
  }

  private broadcast() {
    const lobby = this.lobby();
    const players = this.players;
    for (const m of this.members) {
      if (!m.link || !m.connected) continue;
      const idx = players.indexOf(m);
      const you: You = { index: idx >= 0 ? idx : null, token: m.token, spectator: m.spectator };
      if (!this.ctl) m.link.send({ t: 'lobby', lobby, you });
      else {
        const view = m.seat !== null ? this.ctl.viewFor(m.seat) : this.ctl.spectatorView();
        m.link.send({ t: 'view', view, lobby, you });
      }
    }
  }

  private save() {
    if (!this.opts.save) return;
    this.opts.save({
      v: 1, roomId: this.roomId, savedAt: Date.now(), settings: this.settings,
      members: this.members.map(({ link: _l, connected: _c, ...rest }) => rest),
      seats: this.ctl?.seats, state: this.ctl?.state, offline: this.opts.offline,
    });
  }
}

function cleanName(raw: string, members: Member[]): string {
  const base = (raw || '玩家').trim().replace(/\s+/g, ' ').slice(0, 10) || '玩家';
  const taken = new Set(members.map((m) => m.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}${i}`)) return `${base}${i}`;
}
