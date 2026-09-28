import { describe, expect, it } from 'vitest';
import { decodeSignal, encodeSignal, sdpFromSignal, signalFromSdp } from '../src/net/offline';

describe('離線開房的 QR 代碼', () => {
  const sig = {
    type: 'offer' as const,
    roomId: 'ABC234',
    ufrag: 'Lctf',
    pwd: 'ChSwKZRMi5pfVG4cPsHFzbdG',
    fingerprint: Uint8Array.from({ length: 32 }, (_, i) => (i * 37) % 256),
    candidates: [
      { type: 'host' as const, address: '192.168.1.23', port: 51234 },
      { type: 'host' as const, address: '5f1c2a3b-1111-2222-3333-444455556666.local', port: 60001 },
    ],
  };

  it('編碼後可以解回來，而且夠短（QR code 容易掃）', () => {
    const code = encodeSignal(sig);
    expect(code.length).toBeLessThan(220);
    expect(decodeSignal(code)).toEqual(sig);
  });

  it('還原的 SDP 再解析一次，資訊不變', () => {
    const sdp = sdpFromSignal(sig);
    expect(sdp).toContain('a=setup:actpass');
    expect(signalFromSdp(sdp, 'offer', 'ABC234')).toEqual(sig);
  });

  it('不是這個遊戲的代碼會被拒絕', () => {
    expect(() => decodeSignal('https://example.com')).toThrow();
  });
});
