/**
 * 開房模式畫面：建立房間、等待畫面（網址、QR code、座位）、加入房間、牌局中的連線狀態。
 */
import QRCode from 'qrcode';
import { Wind } from '../engine/tiles';
import { ClientRoom } from '../net/client';
import { HostRoom, HostSnapshot } from '../net/host';
import { connectToHost, HostPeer, openHost } from '../net/peer';
import { decodeSignal, guestAnswer, hostInvite } from '../net/offline';
import { Link } from '../net/protocol';
import { scanQr, showQrDialog } from './qr';
import { LobbyState, newRoomId, RoomSettings, ToClient, ToHost } from '../net/protocol';
import { TableScreen } from './table';
import { settingsSummary } from './settings';
import { esc } from './tiles';

export interface RoomContext {
  app: HTMLElement;
  nickname: string;
  tingHint: boolean;
  goHome(): void;
  setCleanup(fn: () => void): void;
}

const HOST_KEY = (id: string) => `twmj-host-${id}`;
const TOKEN_KEY = (id: string) => `twmj-token-${id}`;
/** 房主離開超過 5 分鐘，房間結束（規格書 4.2） */
const HOST_RESUME_MS = 5 * 60_000;

const store = {
  get(k: string) {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k: string, v: string) {
    try { localStorage.setItem(k, v); } catch { /* 無法儲存時略過 */ }
  },
  del(k: string) {
    try { localStorage.removeItem(k); } catch { /* 略過 */ }
  },
};

/** 網址加上 ?fast 讓 AI 快速出牌（測試用） */
const fastAi = (): [number, number] | undefined =>
  new URLSearchParams(location.search).has('fast') ? [40, 80] : undefined;

export const roomUrl = (id: string) => `${location.origin}${location.pathname}#/r/${id}`;

export function loadHostSnapshot(id: string): HostSnapshot | null {
  const raw = store.get(HOST_KEY(id));
  if (!raw) return null;
  try {
    const snap = JSON.parse(raw) as HostSnapshot;
    return Date.now() - snap.savedAt < HOST_RESUME_MS ? snap : null;
  } catch {
    return null;
  }
}

/** 清掉過期的房主快照與玩家代碼 */
export function pruneStorage() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k?.startsWith('twmj-host-')) continue;
      const snap = JSON.parse(localStorage.getItem(k) ?? '{}') as Partial<HostSnapshot>;
      if (!snap.savedAt || Date.now() - snap.savedAt > 24 * 3600_000) localStorage.removeItem(k);
    }
  } catch { /* 略過 */ }
}

function setHash(id: string | null) {
  const url = id ? `#/r/${id}` : location.pathname + location.search;
  history.replaceState(null, '', url);
}

function busy(app: HTMLElement, title: string, detail = '', buttons = '') {
  app.innerHTML = `<div class="screen setup"><div class="setup-card"><h2>${title}</h2>
    ${detail ? `<p class="muted">${detail}</p>` : '<div class="spinner"></div>'}
    ${buttons ? `<div class="dialog-buttons">${buttons}</div>` : ''}</div></div>`;
}

// ---------------------------------------------------------------- 房主

export async function createRoom(ctx: RoomContext, settings: RoomSettings, offline = false) {
  const id = newRoomId();
  const host = new HostRoom(id, settings, ctx.nickname || '房主', {
    aiDelay: fastAi(),
    offline,
    save: (snap) => store.set(HOST_KEY(id), JSON.stringify(snap)),
  });
  await runHost(ctx, host, false, offline);
}

export async function resumeHost(ctx: RoomContext, snap: HostSnapshot) {
  const host = new HostRoom(snap.roomId, snap.settings, '', {
    aiDelay: fastAi(),
    restore: snap,
    offline: snap.offline,
    save: (s) => store.set(HOST_KEY(snap.roomId), JSON.stringify(s)),
  });
  await runHost(ctx, host, true, !!snap.offline);
}

/** 離線開房：為一位玩家產生邀請 QR，再掃描玩家的回覆 QR（規格書 5.3） */
async function inviteFlow(host: HostRoom) {
  const inv = await hostInvite<ToHost, ToClient>(host.roomId);
  let dlg: ReturnType<typeof showQrDialog> | null = null;
  const cancel = () => {
    inv.cancel();
    dlg?.close();
  };
  dlg = showQrDialog({
    title: '新增玩家',
    steps: [
      '請朋友連到同一個 Wi-Fi（或你的手機熱點）',
      '朋友在首頁按「掃描加入」，掃這個 QR code',
      '朋友手機會出現回覆 QR code，按下方「掃描回覆」掃它',
    ],
    code: inv.code,
    buttons: [
      { id: 'cancel', label: '取消', onClick: cancel },
      {
        id: 'scan', label: '掃描回覆', primary: true, onClick: async () => {
          const text = await scanQr({ title: '掃描朋友的回覆', hint: '掃朋友手機上顯示的回覆 QR code。', accept: isSignal('answer') });
          if (!text) return;
          try {
            await inv.accept(text);
            dlg?.setStatus('<div class="spinner"></div><p>連線中…</p>');
            const link = await inv.link;
            host.accept(link);
            dlg?.close();
          } catch (e) {
            dlg?.setStatus(`<p class="error-line">${esc((e as Error).message || '連線失敗')}，請按取消後重新新增。</p>`);
          }
        },
      },
    ],
  });
}

const isSignal = (type: 'offer' | 'answer') => (text: string) => {
  try {
    return decodeSignal(text).type === type;
  } catch {
    return false;
  }
};

async function runHost(ctx: RoomContext, host: HostRoom, resumed = false, offline = false) {
  const { app } = ctx;
  let peer: HostPeer = { close: () => undefined };
  if (!offline) {
    busy(app, resumed ? '恢復房間中…' : '建立房間中…');
    try {
      peer = await openHost<ToHost, ToClient>(host.roomId, (link) => host.accept(link));
    } catch {
      busy(app, '無法建立房間', '連不上連線服務，請確認網路後再試一次；沒有網路時可以改用「同 Wi-Fi 離線」開房。',
        `<button class="btn" id="home">回首頁</button>`);
      app.querySelector('#home')!.addEventListener('click', ctx.goHome);
      return;
    }
    setHash(host.roomId);
  }

  let table: TableScreen | null = null;
  const endRoom = () => {
    host.close();
    peer.close();
    store.del(HOST_KEY(host.roomId));
    setHash(null);
    ctx.goHome();
  };
  const render = () => {
    if (!host.started) {
      table?.destroy();
      table = null;
      renderLobby(app, host.lobby(), {
        isHost: true, youIndex: 0, offline, onStart: () => host.start(), onLeave: endRoom,
        onInvite: () => void inviteFlow(host),
      });
      return;
    }
    if (!table) {
      app.innerHTML = `<div class="screen game"></div>`;
      table = new TableScreen(app.firstElementChild as HTMLElement, {
        act: (a) => host.hostAct(a),
        nextHand: () => host.hostAct({ type: 'nextHand' }),
        togglePause: () => host.setPaused(!host.ctl!.paused),
        takeBack: () => host.host.seat !== null && host.ctl?.takeBack(host.host.seat as Wind),
        setAutoTing: (on) => host.host.seat !== null && host.ctl?.setAutoTing(host.host.seat as Wind, on),
        leave: () => confirmBox('結束房間？', '所有玩家都會離開這個房間。', '結束房間', endRoom),
        restart: () => host.restart(),
      }, {
        tingHint: ctx.tingHint, role: 'host', roomId: host.roomId,
        assistAllowed: () => host.settings.allowAssist !== false,
        // 離線房間：牌局中也能讓斷線的玩家重新掃描回來
        extra: offline ? { label: '加人', onClick: () => void inviteFlow(host) } : undefined,
      });
    }
    const v = host.hostView();
    if (v) table.render(v);
  };
  const unsub = host.subscribe(render);
  render();
  ctx.setCleanup(() => {
    unsub();
    table?.destroy();
  });
}

// ---------------------------------------------------------------- 玩家

export function joinRoom(ctx: RoomContext, roomId: string, offlineLink?: Link<ToClient, ToHost>) {
  const { app } = ctx;
  const offline = !!offlineLink;
  if (!offline) setHash(roomId);
  let first: Link<ToClient, ToHost> | undefined = offlineLink;
  const connect = offline
    ? async () => {
        // 離線連線只能用一次；斷線後要重新掃描
        const l = first;
        first = undefined;
        if (!l) throw new Error('offline');
        return l;
      }
    : () => connectToHost<ToClient, ToHost>(roomId);
  const client = new ClientRoom(roomId, ctx.nickname || '玩家', connect, {
    get: (r) => store.get(TOKEN_KEY(r)) ?? undefined,
    set: (r, t) => store.set(TOKEN_KEY(r), t),
  }, offline ? { giveUpMs: -1, lostMessage: '和房主的連線中斷了。請房主按「加人」產生新的 QR code，再按「重新掃描」回到原座位。' } : {});
  let table: TableScreen | null = null;
  let everJoined = false;
  const leave = () => {
    client.leave();
    setHash(null);
    ctx.goHome();
  };
  const netOverlay = (html: string) => {
    let el = document.getElementById('net-overlay');
    if (!html) return el?.remove();
    if (!el) {
      el = document.createElement('div');
      el.id = 'net-overlay';
      document.body.appendChild(el);
    }
    el.innerHTML = html;
    el.querySelector('#net-leave')?.addEventListener('click', leave);
  };
  const render = () => {
    const st = client.status;
    if (st === 'joined') everJoined = true;
    if (st === 'closed') {
      netOverlay('');
      table?.destroy();
      table = null;
      busy(app, offline ? '連線中斷' : '房間已結束', esc(client.message ?? ''),
        `<button class="btn" id="home">回首頁</button>${offline ? '<button class="btn primary" id="rescan">重新掃描</button>' : ''}`);
      app.querySelector('#home')!.addEventListener('click', leave);
      app.querySelector('#rescan')?.addEventListener('click', () => {
        client.leave();
        void offlineJoin(ctx);
      });
      return;
    }
    if (!everJoined) {
      const detail = st === 'hostAway'
        ? `找不到房間 <b>${esc(roomId)}</b>。可能房號錯誤、房主已離開，或網路不通；正在重試…`
        : '';
      busy(app, `連線到房間 ${esc(roomId)}…`, detail, `<button class="btn" id="home">回首頁</button>`);
      app.querySelector('#home')!.addEventListener('click', leave);
      return;
    }
    netOverlay(st === 'joined' ? '' : `<div class="overlay"><div class="dialog small">
      <h2>${st === 'hostAway' ? '等待房主回來' : '重新連線中'}</h2>
      <div class="spinner"></div><p>${st === 'hostAway' ? '房主暫時離開，5 分鐘內回來就能接著打。' : '網路中斷，正在自動重新連線…'}</p>
      <div class="dialog-buttons"><button class="btn" id="net-leave">離開房間</button></div></div></div>`);
    const lobby = client.lobby;
    if (!lobby) return;
    if (!client.view) {
      table?.destroy();
      table = null;
      renderLobby(app, lobby, { isHost: false, youIndex: client.you?.index ?? null, onLeave: leave });
      return;
    }
    if (!table) {
      app.innerHTML = `<div class="screen game"></div>`;
      table = new TableScreen(app.firstElementChild as HTMLElement, {
        act: (a) => {
          client.send(a);
          return null;
        },
        nextHand: () => undefined,
        togglePause: () => undefined,
        takeBack: () => client.takeBack(),
        setAutoTing: (on) => client.setAutoTing(on),
        leave: () => confirmBox('離開房間？', offline ? '離開後由 AI 代打，重新掃描房主的 QR code 可以再回來。' : '離開後由 AI 代打，用同一個網址可以再回來。', '離開', leave),
        restart: () => undefined,
      }, {
        tingHint: ctx.tingHint, role: 'guest', roomId, spectator: !!client.you?.spectator,
        // 房主的設定跟著房間狀態一起傳來
        assistAllowed: () => client.lobby?.settings.allowAssist !== false,
      });
    }
    table.render(client.view);
  };
  const unsub = client.subscribe(render);
  render();
  client.start();
  ctx.setCleanup(() => {
    unsub();
    netOverlay('');
    table?.destroy();
  });
}

/** 離線加入：掃房主的邀請 QR，產生回覆 QR 給房主掃 */
export async function offlineJoin(ctx: RoomContext) {
  const { app } = ctx;
  busy(app, '掃描加入', '請掃描房主手機上的邀請 QR code。', `<button class="btn" id="home">回首頁</button>`);
  app.querySelector('#home')!.addEventListener('click', ctx.goHome);
  const text = await scanQr({
    title: '掃描房主的邀請', hint: '請先連到和房主同一個 Wi-Fi，再掃房主手機上的邀請 QR code。', accept: isSignal('offer'),
  });
  if (!text) return ctx.goHome();
  let g: Awaited<ReturnType<typeof guestAnswer<ToClient, ToHost>>>;
  try {
    g = await guestAnswer<ToClient, ToHost>(text);
  } catch (e) {
    busy(app, '無法加入', esc((e as Error).message), `<button class="btn" id="home">回首頁</button>`);
    app.querySelector('#home')!.addEventListener('click', ctx.goHome);
    return;
  }
  const dlg = showQrDialog({
    title: '請房主掃描',
    steps: ['把這個 QR code 給房主看', '房主按「掃描回覆」掃這個 QR code', '連上後會自動進入房間'],
    code: g.code,
    buttons: [{ id: 'cancel', label: '取消', onClick: () => { g.cancel(); dlg.close(); ctx.goHome(); } }],
  });
  dlg.setStatus('<div class="spinner"></div><p>等待房主掃描…</p>');
  try {
    const link = await g.link;
    dlg.close();
    joinRoom(ctx, g.roomId, link);
  } catch {
    dlg.setStatus('<p class="error-line">等太久了，請按取消後重新掃描。</p>');
  }
}

// ---------------------------------------------------------------- 等待畫面

function renderLobby(
  app: HTMLElement, lobby: LobbyState,
  o: { isHost: boolean; youIndex: number | null; offline?: boolean; onStart?: () => void; onInvite?: () => void; onLeave: () => void },
) {
  const url = roomUrl(lobby.roomId);
  const slots = Array.from({ length: 4 }, (_, i) => {
    const p = lobby.players[i];
    if (!p) return `<div class="slot empty"><span class="dot"></span>等待加入…<small>開始時由 AI 補上</small></div>`;
    const tags = [p.isHost ? '<span class="tag">房主</span>' : '', i === o.youIndex ? '<span class="tag you">你</span>' : ''].join('');
    return `<div class="slot"><span class="dot ${p.connected ? 'on' : ''}"></span><b>${esc(p.name)}</b>${tags}</div>`;
  }).join('');
  const spectator = o.youIndex === null;
  app.innerHTML = `<div class="screen setup lobby">
    <div class="setup-card lobby-card">
      <div class="lobby-grid">
        ${o.offline ? `<div class="lobby-share offline">
          <div class="room-code-label">同 Wi-Fi 離線房間</div>
          <div class="room-code">${esc(lobby.roomId)}</div>
          <p class="muted small">不需要網路。每位朋友各掃一次 QR code 加入。</p>
          ${o.isHost ? '<button class="btn primary" id="invite">新增玩家</button>' : ''}
        </div>` : `<div class="lobby-share">
          <div class="room-code-label">房號</div>
          <div class="room-code">${esc(lobby.roomId)}</div>
          <canvas id="qr" width="160" height="160"></canvas>
          <input class="room-url" readonly value="${esc(url)}" aria-label="房間網址">
          <div class="share-row">
            <button class="btn" id="copy">複製連結</button>
            ${'share' in navigator ? '<button class="btn" id="share">分享</button>' : ''}
          </div>
        </div>`}
        <div class="lobby-main">
          <h2>${o.isHost ? '邀請朋友加入' : spectator ? '房間已滿，你是旁觀者' : '等待房主開始'}</h2>
          <div class="slots">${slots}</div>
          ${lobby.spectators ? `<p class="muted">另有 ${lobby.spectators} 位旁觀</p>` : ''}
          <p class="rules-line">${esc(settingsSummary(lobby.settings))}</p>
          <p class="muted small">${o.offline ? '所有人要連在同一個 Wi-Fi，房主的畫面要保持開著。' : '房主的分頁要保持開著，房間才會存在。'}</p>
          <div class="dialog-buttons">
            <button class="btn" id="leave">${o.isHost ? '結束房間' : '離開'}</button>
            ${o.isHost ? '<button class="btn primary" id="start">開始</button>' : ''}
          </div>
        </div>
      </div>
    </div>
  </div>`;
  app.querySelector('#invite')?.addEventListener('click', () => o.onInvite?.());
  app.querySelector('#leave')!.addEventListener('click', o.onLeave);
  app.querySelector('#start')?.addEventListener('click', () => o.onStart?.());
  if (o.offline) return;
  void QRCode.toCanvas(app.querySelector('#qr') as HTMLCanvasElement, url, { width: 160, margin: 1 });
  app.querySelector('#copy')!.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = '已複製';
    } catch {
      const input = app.querySelector<HTMLInputElement>('.room-url')!;
      input.select();
      btn.textContent = '請手動複製上方網址';
    }
  });
  app.querySelector('#share')?.addEventListener('click', () => {
    void navigator.share({ title: '台灣麻將', text: `一起來打麻將！房號 ${lobby.roomId}`, url }).catch(() => undefined);
  });
}

export function confirmBox(title: string, detail: string, okLabel: string, onOk: () => void, onCancel?: () => void) {
  const el = document.createElement('div');
  el.className = 'overlay';
  el.style.zIndex = '60';
  el.innerHTML = `<div class="dialog small"><h2>${title}</h2><p>${detail}</p>
    <div class="dialog-buttons"><button class="btn" data-x="stay">取消</button><button class="btn primary" data-x="ok">${okLabel}</button></div></div>`;
  document.body.appendChild(el);
  el.addEventListener('click', (e) => {
    const x = (e.target as HTMLElement).dataset.x;
    if (x === 'stay') {
      el.remove();
      onCancel?.();
    }
    if (x === 'ok') {
      el.remove();
      onOk();
    }
  });
}
