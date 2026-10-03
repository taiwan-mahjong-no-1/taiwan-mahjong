/**
 * 開房連線的訊息格式（規格書第 7 節）。
 * 每位玩家與房主之間一條可靠、依序的資料通道，訊息為 JSON。
 * 房主只把「這位玩家看得到的畫面」傳出去，絕不傳整個 GameState。
 */
import { Action } from '../engine/game';
import { TableView } from '../game/controller';

export interface RoomSettings {
  level: 'easy' | 'normal' | 'hard';
  rounds: 1 | 4;
  base: number;
  perTai: number;
  discardSeconds: number;
  /** 吃碰槓胡的宣告秒數；0 = 不限時（舊房間沒有這欄時用 8 秒） */
  claimSeconds?: number;
  /** 真人斷線或連續逾時時，AI 代打的強度（舊房間沒有這欄時用困難） */
  autoLevel?: 'easy' | 'normal' | 'hard';
  /** 是否允許玩家開輔助模式（AI 提示）；舊房間沒有這欄時視為允許 */
  allowAssist?: boolean;
  multiWin: boolean;
  leopardDouble: boolean;
}

export interface LobbyPlayer {
  name: string;
  connected: boolean;
  isHost: boolean;
}

export interface LobbyState {
  roomId: string;
  settings: RoomSettings;
  players: LobbyPlayer[];
  started: boolean;
  spectators: number;
}

export interface You {
  /** 在 lobby.players 裡的位置；旁觀者為 null */
  index: number | null;
  token: string;
  spectator: boolean;
}

/** 聊天訊息（開房時才有；房主轉發給房間裡每個人，旁觀者也可以發言） */
export interface ChatMsg {
  id: number;
  name: string;
  role: 'host' | 'player' | 'spectator';
  text: string;
  at: number;
  /** 是不是收到這則的人自己發的（房主依收件人填） */
  mine?: boolean;
}

/** 聊天訊息最多幾個字、房主保留幾則紀錄、同一人兩則之間至少隔多久 */
export const CHAT_MAX_LEN = 60;
export const CHAT_KEEP = 100;
export const CHAT_GAP_MS = 800;

/** 整理聊天文字：去頭尾空白、合併連續空白、限制長度 */
export const cleanChat = (raw: unknown) =>
  typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_LEN) : '';

export type ToHost =
  | { t: 'hello'; name: string; token?: string }
  | { t: 'action'; action: Action }
  | { t: 'takeBack' }
  /** 聽牌自動摸打開關（只影響自己，別人看不到） */
  | { t: 'autoTing'; on: boolean }
  | { t: 'chat'; text: string }
  | { t: 'bye' };

export type ToClient =
  | { t: 'lobby'; lobby: LobbyState; you: You }
  | { t: 'view'; view: TableView; lobby: LobbyState; you: You }
  | { t: 'error'; message: string }
  /** 一則新的聊天訊息 */
  | { t: 'chat'; msg: ChatMsg }
  /** 加入或重新連線時，補上之前的聊天紀錄 */
  | { t: 'chatLog'; msgs: ChatMsg[] }
  | { t: 'closed'; reason: string };

/** 一條雙向連線（PeerJS 或測試用的記憶體連線） */
export interface Link<In, Out> {
  send(msg: Out): void;
  onMessage(cb: (msg: In) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

/** 房號：6 碼，排除 0/O、1/I 這些容易看錯的字 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newRoomId(): string {
  const buf = new Uint32Array(6);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (n) => ALPHABET[n % ALPHABET.length]).join('');
}

export function newToken(): string {
  const buf = new Uint32Array(4);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (n) => n.toString(36)).join('');
}

export const normalizeRoomId = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
