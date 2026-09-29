/**
 * 語音：出牌念牌名，吃碰槓胡等動作念出來（錄音檔在 public/assets/voice）。
 * 可切換語音版本（跟牌的風格一樣，每位玩家自己選）；其他版本放在 public/assets/voice/<版本>/，
 * 該版本沒錄到的語音（放槍、流局、豹子等）改用預設版本的錄音。
 * 每位玩家在自己的畫面開關、調音量，存在自己的瀏覽器；只根據自己收到的畫面變化播放，
 * 不需要房主另外傳送。
 */
import type { PlayerView } from '../engine/game';
import { kindOf } from '../engine/game';
import { FILES } from './tiles';

export type VoicePack = 'default' | 'recorded';
export interface VoiceSettings { on: boolean; volume: number; pack: VoicePack }

const TILE_KEYS = FILES.slice(0, 34);
/** 語音版本；keys 為這個版本有錄的語音，其餘用預設版本 */
export const VOICE_PACKS: { id: VoicePack; name: string; keys: Set<string> | null }[] = [
  { id: 'default', name: '預設', keys: null },
  { id: 'recorded', name: '自錄', keys: new Set([...TILE_KEYS, 'chi', 'pon', 'kong', 'ting', 'hule', 'tsumo', 'flower']) },
];
const isPack = (p: unknown): p is VoicePack => VOICE_PACKS.some((x) => x.id === p);
const KEY = 'taiwan-mahjong:voice';
const BASE = `${import.meta.env.BASE_URL}assets/voice/`;

export function loadVoice(): VoiceSettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (v && typeof v.on === 'boolean' && typeof v.volume === 'number') {
      return { on: v.on, volume: v.volume, pack: isPack(v.pack) ? v.pack : 'default' };
    }
  } catch {
    /* 讀不到就用預設 */
  }
  return { on: true, volume: 0.8, pack: 'default' };
}

export function saveVoice(v: VoiceSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* 無法儲存時略過 */
  }
}

// ---------------------------------------------------------------- 播放

type Ctx = AudioContext;
let ctx: Ctx | null = null;
const buffers = new Map<string, Promise<AudioBuffer | null>>();
let queue: string[] = [];
let playing = false;
let settings = loadVoice();

export function setVoice(v: VoiceSettings) {
  const packChanged = v.pack !== settings.pack;
  settings = v;
  saveVoice(v);
  if (!v.on || packChanged) queue = [];
  if (packChanged) preloadVoice();
}

export function getVoice(): VoiceSettings {
  return settings;
}

/** 手機瀏覽器要使用者點過畫面才能出聲：第一次點擊時啟動音訊 */
export function unlockAudio() {
  const AC = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
    ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return;
  if (!ctx) ctx = new AC();
  if (ctx.state === 'suspended') void ctx.resume();
}

/** 目前版本的錄音網址；這個版本沒錄的用預設版本 */
function urlOf(key: string): string {
  const pack = VOICE_PACKS.find((x) => x.id === settings.pack);
  return pack?.keys?.has(key) ? `${BASE}${pack.id}/${key}.mp3` : `${BASE}${key}.mp3`;
}

function load(key: string): Promise<AudioBuffer | null> {
  const url = urlOf(key);
  let p = buffers.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((b) => ctx!.decodeAudioData(b))
      .catch(() => null);
    buffers.set(url, p);
  }
  return p;
}

/** 開局先載入常用的語音，第一次播放不會延遲 */
export function preloadVoice() {
  if (!ctx) return;
  for (const f of TILE_KEYS) void load(f);
  for (const k of ['chi', 'pon', 'kong', 'ting', 'hule', 'fangqiang', 'tsumo', 'flower']) void load(k);
}

export function say(keys: string[]) {
  if (!settings.on || !keys.length) return;
  // 堆太多就丟掉舊的，免得語音落後畫面
  queue = [...queue, ...keys].slice(-3);
  if (!playing) void next();
}

async function next() {
  const key = queue.shift();
  if (!key || !ctx || ctx.state !== 'running') {
    playing = false;
    return;
  }
  playing = true;
  const buf = await load(key);
  if (!buf || !settings.on) return next();
  const src = ctx.createBufferSource();
  const gain = ctx.createGain();
  gain.gain.value = settings.volume;
  src.buffer = buf;
  src.connect(gain).connect(ctx.destination);
  src.onended = () => void next();
  src.start();
}

// ---------------------------------------------------------------- 畫面變化 → 要念什麼

const kongTypes = new Set(['minkan', 'ankan', 'kakan']);

/** 畫面的精簡快照（只記數量）；單人模式的畫面和狀態共用陣列，不能直接拿舊畫面來比 */
export interface VoiceSnap {
  handNo: number;
  over: boolean;
  seats: { discards: number; chi: number; pon: number; kong: number; flowers: number; declared: boolean }[];
}

const isOver = (v: PlayerView) => v.phase.kind === 'handOver' || v.phase.kind === 'matchOver';

export function voiceSnap(v: PlayerView): VoiceSnap {
  return {
    handNo: v.handNo,
    over: isOver(v),
    seats: v.players.map((p) => ({
      discards: p.discards.length,
      chi: p.melds.filter((m) => m.type === 'chi').length,
      pon: p.melds.filter((m) => m.type === 'pon').length,
      kong: p.melds.filter((m) => kongTypes.has(m.type)).length,
      flowers: p.flowers.length,
      declared: !!p.declared,
    })),
  };
}

/** 比較前一個快照與新畫面，找出要念的語音（同一局才比；換局時只念豹子） */
export function announce(prev: VoiceSnap | null, next: PlayerView): string[] {
  const out: string[] = [];
  if (!prev || prev.handNo !== next.handNo) {
    if (next.leopard && !isOver(next)) out.push('leopard');
    return out;
  }
  // 一次畫面更新裡可能包含好幾件事（例：打牌沒人要 → 下家摸牌補花），照發生的先後念：
  // 報聽與打出的牌 → 吃碰槓 → 補花
  const ting: string[] = [];
  const discards: string[] = [];
  const melds: string[] = [];
  const flowerSays: string[] = [];
  const snap = voiceSnap(next);
  next.players.forEach((b, seat) => {
    const a = prev.seats[seat];
    const now = snap.seats[seat];
    if (now.declared && !a.declared) ting.push('ting');
    if (b.discards.length > a.discards) discards.push(FILES[kindOf(b.discards[b.discards.length - 1])]);
    if (now.chi > a.chi) melds.push('chi');
    if (now.pon > a.pon) melds.push('pon');
    if (now.kong > a.kong) melds.push('kong');
    if (now.flowers > a.flowers) flowerSays.push('flower');
  });
  out.push(...ting, ...discards, ...melds, ...flowerSays);
  // 花牌收分：8 張花都出現時
  const flowers = next.players.map((p) => p.flowers.length);
  const before = prev.seats.reduce((n, p) => n + p.flowers, 0);
  if (before < 8 && flowers.reduce((x, y) => x + y, 0) === 8) {
    if (flowers.includes(8)) out.push('eight');
    else if (flowers.filter((n) => n > 0).length === 2 && flowers.includes(7)) out.push('seven');
  }
  // 一局結束
  if (!prev.over && (next.phase.kind === 'handOver' || next.phase.kind === 'matchOver')) {
    const r = next.phase.result;
    if (r.type === 'draw') out.push('draw');
    // 胡別人的牌：胡的人聽到「胡了」、放槍的人聽到「放槍」，其他人不播；自摸大家都聽得到
    let dealtIn = false;
    for (const w of r.wins) {
      if (w.from === undefined) out.push('tsumo');
      else if (w.seat === next.seat) out.push('hule');
      else if (w.from === next.seat && !dealtIn) {
        out.push('fangqiang');
        dealtIn = true;
      }
      for (const it of w.score.items) {
        if (it.key === 'heavenly' || it.key === 'earthly' || it.key === 'miji' || it.key === 'tianting') out.push(it.key);
      }
    }
  }
  return out;
}
