/**
 * 玩家端：連到房主、收畫面、送動作；斷線時自動重連（規格書 4.2）。
 */
import { Action } from '../engine/game';
import { TableView } from '../game/controller';
import { CHAT_KEEP, ChatMsg, LobbyState, Link, ToClient, ToHost, You } from './protocol';

export type ClientStatus =
  | 'connecting' // 第一次連線中
  | 'joined' // 已在房間
  | 'reconnecting' // 斷線，重連中
  | 'hostAway' // 找不到房主（房主離開或網路問題）
  | 'closed'; // 房間已結束

export interface TokenStore {
  get(roomId: string): string | undefined;
  set(roomId: string, token: string): void;
}

export interface ClientOptions {
  retryMs?: number;
  /** 找不到房主多久後放棄（規格書：房主離開超過 5 分鐘房間結束） */
  giveUpMs?: number;
  /** 放棄重連時顯示的訊息 */
  lostMessage?: string;
}

export class ClientRoom {
  status: ClientStatus = 'connecting';
  lobby: LobbyState | null = null;
  view: TableView | null = null;
  you: You | null = null;
  message: string | null = null;
  chat: ChatMsg[] = [];
  private chatListeners = new Set<() => void>();
  private link: Link<ToClient, ToHost> | null = null;
  private listeners = new Set<() => void>();
  private retryTimer?: ReturnType<typeof setTimeout>;
  private lostAt: number | null = null;
  private stopped = false;

  constructor(
    public roomId: string,
    public name: string,
    private connect: () => Promise<Link<ToClient, ToHost>>,
    private tokens: TokenStore,
    private opts: ClientOptions = {},
  ) {}

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 聊天有新訊息時通知（不會重畫牌桌） */
  onChat(fn: () => void) {
    this.chatListeners.add(fn);
    return () => this.chatListeners.delete(fn);
  }

  sendChat(text: string) {
    this.link?.send({ t: 'chat', text });
  }

  start() {
    void this.attempt();
  }

  send(action: Action) {
    this.link?.send({ t: 'action', action });
  }

  takeBack() {
    this.link?.send({ t: 'takeBack' });
  }

  setAutoTing(on: boolean) {
    this.link?.send({ t: 'autoTing', on });
  }

  leave() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.link?.send({ t: 'bye' });
    this.link?.close();
    this.listeners.clear();
    this.chatListeners.clear();
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  private async attempt() {
    if (this.stopped) return;
    try {
      const link = await this.connect();
      if (this.stopped) {
        link.close();
        return;
      }
      this.link = link;
      link.onMessage((m) => this.onMessage(m));
      link.onClose(() => {
        if (this.link !== link) return;
        this.link = null;
        this.lost('reconnecting');
      });
      link.send({ t: 'hello', name: this.name, token: this.tokens.get(this.roomId) });
    } catch {
      this.lost(this.status === 'connecting' || this.status === 'hostAway' ? 'hostAway' : 'reconnecting');
    }
  }

  private lost(status: ClientStatus) {
    if (this.stopped || this.status === 'closed') return;
    this.lostAt ??= Date.now();
    const giveUp = this.opts.giveUpMs ?? 5 * 60_000;
    if (Date.now() - this.lostAt > giveUp) {
      this.status = 'closed';
      this.message = this.opts.lostMessage ?? '找不到房主，房間已結束';
      this.changed();
      return;
    }
    this.status = status;
    this.changed();
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.attempt(), this.opts.retryMs ?? 2500);
  }

  private onMessage(m: ToClient) {
    if (m.t === 'chat' || m.t === 'chatLog') {
      if (m.t === 'chatLog') this.chat = m.msgs;
      else if (!this.chat.some((c) => c.id === m.msg.id)) this.chat = [...this.chat, m.msg].slice(-CHAT_KEEP);
      for (const fn of this.chatListeners) fn();
      return;
    }
    switch (m.t) {
      case 'lobby':
      case 'view':
        this.lostAt = null;
        this.status = 'joined';
        this.lobby = m.lobby;
        this.you = m.you;
        this.view = m.t === 'view' ? m.view : null;
        this.tokens.set(this.roomId, m.you.token);
        break;
      case 'error':
        this.message = m.message;
        break;
      case 'closed':
        this.status = 'closed';
        this.message = m.reason;
        this.stopped = true;
        this.link?.close();
        break;
    }
    this.changed();
  }
}
