/**
 * 同 Wi-Fi 離線開房（規格書 5.3）：不經過任何伺服器，房主與玩家互掃 QR code 交換 WebRTC 連線資訊。
 * 連線資訊（SDP）會壓縮成一小段文字，讓 QR code 夠小、手機容易掃。
 */
import { Link } from './protocol';

const MAGIC = 'TWMJ1';
const HEARTBEAT_MS = 4000;
const DEAD_MS = 15000;

export interface Signal {
  type: 'offer' | 'answer';
  roomId: string;
  ufrag: string;
  pwd: string;
  /** 憑證指紋（SHA-256，32 bytes） */
  fingerprint: Uint8Array;
  candidates: { type: 'host' | 'srflx'; address: string; port: number }[];
}

// ---------------------------------------------------------------- 編碼

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

export function encodeSignal(s: Signal): string {
  const cands = s.candidates.map((c) => `${c.type === 'host' ? 'h' : 's'}~${c.address}~${c.port}`).join(',');
  return [MAGIC, s.type === 'offer' ? 'O' : 'A', s.roomId, s.ufrag, s.pwd, b64url(s.fingerprint), cands].join('|');
}

export function decodeSignal(code: string): Signal {
  const parts = code.trim().split('|');
  if (parts.length !== 7 || parts[0] !== MAGIC) throw new Error('不是這個遊戲的 QR code');
  const [, t, roomId, ufrag, pwd, fp, cands] = parts;
  return {
    type: t === 'O' ? 'offer' : 'answer',
    roomId, ufrag, pwd,
    fingerprint: fromB64url(fp),
    candidates: cands ? cands.split(',').map((c) => {
      const [ty, address, port] = c.split('~');
      return { type: ty === 'h' ? 'host' : 'srflx', address, port: Number(port) };
    }) : [],
  };
}

/** 從瀏覽器產生的 SDP 取出必要資訊 */
export function signalFromSdp(sdp: string, type: Signal['type'], roomId: string): Signal {
  const line = (prefix: string) => sdp.split(/\r?\n/).find((l) => l.startsWith(prefix))?.slice(prefix.length).trim() ?? '';
  const fpHex = line('a=fingerprint:sha-256 ');
  const fingerprint = Uint8Array.from(fpHex.split(':').map((h) => parseInt(h, 16)));
  const seen = new Set<string>();
  const candidates: Signal['candidates'] = [];
  for (const l of sdp.split(/\r?\n/)) {
    const m = l.match(/^a=candidate:\S+ 1 udp \d+ (\S+) (\d+) typ (host|srflx)/i);
    if (!m) continue;
    const key = `${m[1]}:${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ type: m[3] as 'host' | 'srflx', address: m[1], port: Number(m[2]) });
  }
  return { type, roomId, ufrag: line('a=ice-ufrag:'), pwd: line('a=ice-pwd:'), fingerprint, candidates: candidates.slice(0, 4) };
}

/** 還原成瀏覽器能接受的 SDP */
export function sdpFromSignal(s: Signal): string {
  const fp = Array.from(s.fingerprint, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
  const cands = s.candidates.map((c, i) =>
    `a=candidate:${i + 1} 1 udp ${c.type === 'host' ? 2122260223 - i : 1686052607 - i} ${c.address} ${c.port} typ ${c.type}${c.type === 'srflx' ? ' raddr 0.0.0.0 rport 0' : ''}`);
  return [
    'v=0',
    `o=- ${Date.now()} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    ...cands,
    `a=ice-ufrag:${s.ufrag}`,
    `a=ice-pwd:${s.pwd}`,
    `a=fingerprint:sha-256 ${fp}`,
    `a=setup:${s.type === 'offer' ? 'actpass' : 'active'}`,
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    '',
  ].join('\r\n');
}

// ---------------------------------------------------------------- 連線

const RTC_CONFIG: RTCConfiguration = { iceServers: [] };

function waitIce(pc: RTCPeerConnection, ms = 3000): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const t = setTimeout(resolve, ms);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t);
        resolve();
      }
    });
  });
}

function openChannel(pc: RTCPeerConnection) {
  // 雙方各自建立同一條 id 0 的通道，不需要再交換通道資訊
  return pc.createDataChannel('game', { negotiated: true, id: 0, ordered: true });
}

function waitOpen<In, Out>(pc: RTCPeerConnection, dc: RTCDataChannel, ms = 120000): Promise<Link<In, Out>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pc.close();
      reject(new Error('連線逾時'));
    }, ms);
    dc.addEventListener('open', () => {
      clearTimeout(t);
      resolve(wrapChannel<In, Out>(pc, dc));
    });
  });
}

export function wrapChannel<In, Out>(pc: RTCPeerConnection, dc: RTCDataChannel): Link<In, Out> {
  const msgHandlers: ((m: In) => void)[] = [];
  const closeHandlers: (() => void)[] = [];
  let closed = false;
  let lastSeen = Date.now();
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(hb);
    try { dc.close(); pc.close(); } catch { /* 已關閉 */ }
    closeHandlers.forEach((c) => c());
  };
  const hb = setInterval(() => {
    if (Date.now() - lastSeen > DEAD_MS) return finish();
    if (dc.readyState === 'open') dc.send('{"__hb":1}');
  }, HEARTBEAT_MS);
  dc.addEventListener('message', (e) => {
    lastSeen = Date.now();
    const data = JSON.parse(String(e.data));
    if (data && typeof data === 'object' && '__hb' in data) return;
    msgHandlers.forEach((h) => h(data as In));
  });
  dc.addEventListener('close', finish);
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') finish();
  });
  return {
    send: (m) => {
      if (!closed && dc.readyState === 'open') dc.send(JSON.stringify(m));
    },
    onMessage: (cb) => void msgHandlers.push(cb),
    onClose: (cb) => void closeHandlers.push(cb),
    close: finish,
  };
}

/** 房主：為一位新玩家產生邀請碼；拿到玩家的回覆碼後完成連線 */
export async function hostInvite<In, Out>(roomId: string) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const dc = openChannel(pc);
  await pc.setLocalDescription(await pc.createOffer());
  await waitIce(pc);
  const code = encodeSignal(signalFromSdp(pc.localDescription!.sdp, 'offer', roomId));
  const link = waitOpen<In, Out>(pc, dc);
  link.catch(() => undefined);
  return {
    code,
    link,
    async accept(answerCode: string) {
      const s = decodeSignal(answerCode);
      if (s.type !== 'answer') throw new Error('這是邀請碼，請掃描玩家手機上的「回覆」QR code');
      if (s.roomId !== roomId) throw new Error('這個回覆不是這個房間的');
      await pc.setRemoteDescription({ type: 'answer', sdp: sdpFromSignal(s) });
    },
    cancel: () => pc.close(),
  };
}

/** 玩家：掃到房主的邀請碼後，產生回覆碼給房主掃 */
export async function guestAnswer<In, Out>(offerCode: string) {
  const s = decodeSignal(offerCode);
  if (s.type !== 'offer') throw new Error('這是回覆碼，請掃描房主手機上的「邀請」QR code');
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const dc = openChannel(pc);
  await pc.setRemoteDescription({ type: 'offer', sdp: sdpFromSignal(s) });
  await pc.setLocalDescription(await pc.createAnswer());
  await waitIce(pc);
  const code = encodeSignal(signalFromSdp(pc.localDescription!.sdp, 'answer', s.roomId));
  const link = waitOpen<In, Out>(pc, dc);
  link.catch(() => undefined);
  return { code, roomId: s.roomId, link, cancel: () => pc.close() };
}
