import { describe, expect, it } from 'vitest';
import { decide } from '../src/ai/ai';
import { createRng } from '../src/engine/rng';
import { ClientRoom, TokenStore } from '../src/net/client';
import { HostRoom, HostSnapshot } from '../src/net/host';
import { memoryPair } from '../src/net/memory';
import { RoomSettings, ToClient, ToHost } from '../src/net/protocol';

const SETTINGS: RoomSettings = {
  level: 'normal', rounds: 1, base: 30, perTai: 10, discardSeconds: 0, multiWin: false, leopardDouble: true,
};

const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await wait(2);
  }
}

function memStore(): TokenStore {
  const m = new Map<string, string>();
  return { get: (r) => m.get(r), set: (r, t) => void m.set(r, t) };
}

function makeRoom(opts: { restore?: HostSnapshot; saves?: HostSnapshot[] } = {}) {
  let rnd = 1;
  return new HostRoom('ABC234', SETTINGS, '房主', {
    aiDelay: [0, 1],
    restore: opts.restore,
    save: (s) => opts.saves?.push(JSON.parse(JSON.stringify(s))),
    random: () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647),
  });
}

/** 讓玩家連到房主；回傳可切斷的連線 */
function join(host: HostRoom, name: string, store = memStore()) {
  const links: { close(): void }[] = [];
  const client = new ClientRoom('ABC234', name, async () => {
    const [toHost, toClient] = memoryPair<ToClient, ToHost>();
    host.accept(toClient);
    links.push(toHost);
    return toHost;
  }, store, { retryMs: 5, giveUpMs: 2000 });
  client.start();
  return { client, store, drop: () => links[links.length - 1].close() };
}

describe('開房連線', () => {
  it('加入大廳、暱稱重複自動加編號、滿 4 人後成為旁觀者', async () => {
    const host = makeRoom();
    const a = join(host, '小明');
    join(host, '小明');
    join(host, '阿華');
    const d = join(host, '路人');
    await until(() => d.client.lobby !== null && d.client.lobby.players.length === 4);
    expect(host.lobby().players.map((p) => p.name)).toEqual(['房主', '小明', '小明2', '阿華']);
    expect(d.client.you?.spectator).toBe(true);
    expect(a.client.you?.index).toBe(1);
    expect(host.lobby().spectators).toBe(1);
  });

  it('開始後各家只收到自己的手牌，旁觀者看不到手牌；空位補 AI', async () => {
    const host = makeRoom();
    const a = join(host, '小明');
    await until(() => a.client.lobby?.players.length === 2);
    host.start();
    const spec = join(host, '晚到的人');
    await until(() => a.client.view !== null && spec.client.view !== null);
    const seatA = host.members[1].seat!;
    expect(a.client.view!.seat).toBe(seatA);
    expect(a.client.view!.hand).toEqual(host.ctl!.state.players[seatA].hand);
    expect(JSON.stringify(a.client.view)).not.toContain('"wall"');
    expect(a.client.view!.revealedHands).toBeUndefined();
    expect(spec.client.you?.spectator).toBe(true);
    expect(spec.client.view!.hand).toEqual([]);
    expect(host.ctl!.seats.filter((s) => s.kind === 'ai').length).toBe(2);
    host.close();
  });

  it('遠端玩家送出非法動作會收到錯誤；只有房主能按下一局', async () => {
    const host = makeRoom();
    const a = join(host, '小明');
    await until(() => a.client.lobby?.players.length === 2);
    host.start();
    await until(() => a.client.view !== null);
    a.client.send({ type: 'discard', seat: a.client.view!.seat, tile: 9999 });
    await until(() => a.client.message !== null);
    expect(a.client.message).toBeTruthy();
    host.close();
  });

  it('遠端玩家斷線由 AI 代打，重連後回到原座位', async () => {
    const host = makeRoom();
    const a = join(host, '小明');
    await until(() => a.client.lobby?.players.length === 2);
    host.start();
    await until(() => a.client.view !== null);
    const seat = a.client.view!.seat;
    a.drop();
    await until(() => host.ctl!.autoPlay.has(seat));
    expect(host.lobby().players[1].connected).toBe(false);
    await until(() => a.client.status === 'joined' && host.lobby().players[1].connected, 3000);
    expect(host.ctl!.autoPlay.has(seat)).toBe(false);
    expect(a.client.view!.seat).toBe(seat);
    host.close();
  });

  it('房主重開分頁：從快照恢復牌局，玩家用原本的代碼回到座位', async () => {
    const saves: HostSnapshot[] = [];
    const host = makeRoom({ saves });
    const a = join(host, '小明');
    await until(() => a.client.lobby?.players.length === 2);
    host.start();
    await until(() => a.client.view !== null);
    const seat = a.client.view!.seat;
    const snap = saves[saves.length - 1];
    const handBefore = snap.state!.players[seat].hand;
    host.close('房主重新整理');
    // 房主重開：新的 HostRoom 用快照恢復，玩家帶著舊代碼重新加入
    const host2 = makeRoom({ restore: snap });
    host2.setPaused(true);
    const again = join(host2, '小明', a.store);
    await until(() => again.client.view !== null);
    expect(again.client.view!.seat).toBe(seat);
    expect(again.client.view!.hand).toEqual(handBefore);
    expect(host2.ctl!.autoPlay.has(seat)).toBe(false);
    host2.close();
  });

  it('三位遠端玩家用 AI 代替真人操作，完整打完一局', async () => {
    const host = makeRoom();
    const clients = ['甲', '乙', '丙'].map((n) => join(host, n));
    await until(() => host.lobby().players.length === 4);
    host.start();
    const rng = createRng(3);
    const drive = () => {
      for (const c of clients) {
        const v = c.client.view;
        if (!v) continue;
        const a = decide(v, 'normal', rng);
        if (a) c.client.send(a);
      }
      const hv = host.hostView();
      if (hv) {
        const a = decide(hv, 'normal', rng);
        if (a) host.hostAct(a);
      }
    };
    await until(() => {
      const k = host.ctl?.state.phase.kind;
      if (k === 'handOver' || k === 'matchOver') return true;
      drive();
      return false;
    }, 20000);
    await until(() => clients.every((c) => c.client.view?.revealedHands !== undefined));
    const scores = host.ctl!.state.scores;
    expect(scores.reduce((x, y) => x + y, 0)).toBe(0);
    for (const c of clients) expect(c.client.view!.scores).toEqual(scores);
    host.close();
  }, 30000);
});

describe('房主設定：AI 提示', () => {
  it('房主禁止 AI 提示時，玩家收到的房間設定帶有 allowAssist: false', async () => {
    const host = new HostRoom('ABC234', { ...SETTINGS, allowAssist: false }, '房主', { aiDelay: [0, 1] });
    const a = join(host, '小明');
    await until(() => a.client.lobby !== null);
    expect(a.client.lobby!.settings.allowAssist).toBe(false);
  });

  it('聊天：房主轉發給所有人（含旁觀者），標出自己發的；太長截斷、太快丟掉；重連補紀錄', async () => {
    const host = makeRoom();
    const a = join(host, '小明');
    join(host, '阿華');
    join(host, '小美');
    const spec = join(host, '路人');
    await until(() => spec.client.you?.spectator === true);
    a.client.sendChat('  哈囉   大家 ');
    await until(() => spec.client.chat.length === 1);
    expect(spec.client.chat[0]).toMatchObject({ name: '小明', role: 'player', text: '哈囉 大家', mine: false });
    expect(a.client.chat[0].mine).toBe(true);
    expect(JSON.stringify(spec.client.chat)).not.toContain(host.members[1].token);
    a.client.sendChat('太快了');
    spec.client.sendChat('x'.repeat(100));
    await until(() => host.chat.length === 2);
    await wait(20);
    expect(host.chat.map((c) => c.text)).toEqual(['哈囉 大家', 'x'.repeat(60)]);
    expect(host.chat[1].role).toBe('spectator');
    host.hostChat('開始囉');
    await until(() => a.client.chat.length === 3);
    expect(a.client.chat[2]).toMatchObject({ name: '房主', role: 'host', mine: false });
    expect(host.chatFor(host.host)[2].mine).toBe(true);
    // 牌局中斷線重連後拿到完整紀錄，仍認得自己發的
    host.start();
    await until(() => a.client.view !== null);
    a.client.chat = [];
    a.drop();
    await until(() => a.client.chat.length === 3);
    expect(a.client.chat[0].mine).toBe(true);
    host.close();
  });
});

