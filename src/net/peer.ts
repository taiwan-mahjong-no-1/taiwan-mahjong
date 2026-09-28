/**
 * PeerJS 連線（規格書 5.2）：透過公開信令服務交換連線資訊，連上後資料直接在玩家之間傳送。
 * 網址加上 ?peer=主機:埠 可改用自架的 PeerServer（本機測試用）。
 */
import Peer, { DataConnection, PeerOptions } from 'peerjs';
import { Link } from './protocol';

const PREFIX = 'twmj-';
const HEARTBEAT_MS = 4000;
const DEAD_MS = 15000;

function peerOptions(): PeerOptions {
  const custom = new URLSearchParams(location.search).get('peer');
  const base: PeerOptions = {
    debug: 0,
    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] },
  };
  if (!custom) return base;
  const [host, port] = custom.split(':');
  return { ...base, host, port: Number(port || 9000), path: '/', secure: false };
}

/** 把 PeerJS 的資料通道包成 Link，並加上心跳：15 秒沒收到任何訊息就視為斷線 */
function wrap<In, Out>(conn: DataConnection): Link<In, Out> {
  const msgHandlers: ((m: In) => void)[] = [];
  const closeHandlers: (() => void)[] = [];
  let closed = false;
  let lastSeen = Date.now();
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(hb);
    closeHandlers.forEach((c) => c());
  };
  const hb = setInterval(() => {
    if (Date.now() - lastSeen > DEAD_MS) {
      conn.close();
      finish();
      return;
    }
    try {
      conn.send({ __hb: 1 });
    } catch {
      /* 連線已斷，交給上面的逾時處理 */
    }
  }, HEARTBEAT_MS);
  conn.on('data', (d) => {
    lastSeen = Date.now();
    if (d && typeof d === 'object' && '__hb' in (d as object)) return;
    msgHandlers.forEach((h) => h(d as In));
  });
  conn.on('close', finish);
  conn.on('error', finish);
  return {
    send: (m) => {
      if (!closed) conn.send(m);
    },
    onMessage: (cb) => void msgHandlers.push(cb),
    onClose: (cb) => void closeHandlers.push(cb),
    close: () => {
      conn.close();
      finish();
    },
  };
}

export interface HostPeer {
  close(): void;
}

/**
 * 以房號註冊為房主。房主剛重新整理時，舊的代碼可能還被信令服務占用，會自動重試。
 */
export function openHost<In, Out>(
  roomId: string, onLink: (link: Link<In, Out>) => void, opts: { retryForMs?: number } = {},
): Promise<HostPeer> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tryOpen = () => {
      const peer = new Peer(PREFIX + roomId, peerOptions());
      let opened = false;
      peer.on('open', () => {
        opened = true;
        resolve({ close: () => peer.destroy() });
      });
      peer.on('connection', (conn) => {
        conn.on('open', () => onLink(wrap<In, Out>(conn)));
      });
      peer.on('disconnected', () => {
        // 與信令服務斷線（已連上的玩家不受影響），重新登記以便新玩家加入
        if (!peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 1000);
      });
      peer.on('error', (err: { type?: string }) => {
        if (opened) return;
        peer.destroy();
        if (err.type === 'unavailable-id' && Date.now() - t0 < (opts.retryForMs ?? 60000)) setTimeout(tryOpen, 2000);
        else reject(err);
      });
    };
    tryOpen();
  });
}

let clientPeer: Peer | null = null;
let clientReady: Promise<Peer> | null = null;

function getClientPeer(): Promise<Peer> {
  if (clientPeer && !clientPeer.destroyed && !clientPeer.disconnected && clientReady) return clientReady;
  clientPeer?.destroy();
  const peer = new Peer(peerOptions());
  clientPeer = peer;
  clientReady = new Promise((resolve, reject) => {
    peer.on('open', () => resolve(peer));
    peer.on('error', (e) => reject(e));
  });
  return clientReady;
}

/** 玩家連到房主；房主不在時 10 秒內失敗 */
export async function connectToHost<In, Out>(roomId: string): Promise<Link<In, Out>> {
  const peer = await getClientPeer();
  return new Promise((resolve, reject) => {
    const conn = peer.connect(PREFIX + roomId, { reliable: true, serialization: 'json' });
    const timer = setTimeout(() => {
      conn.close();
      reject(new Error('timeout'));
    }, 10000);
    const onErr = (e: { type?: string }) => {
      if (e.type === 'peer-unavailable') {
        clearTimeout(timer);
        peer.off('error', onErr);
        reject(new Error('host unavailable'));
      }
    };
    peer.on('error', onErr);
    conn.on('open', () => {
      clearTimeout(timer);
      peer.off('error', onErr);
      resolve(wrap<In, Out>(conn));
    });
  });
}
