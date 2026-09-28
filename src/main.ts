import './ui/style.css';
import { DEFAULT_RULES, GameRules } from './engine/game';
import { DEFAULT_SCORE_RULES } from './engine/settlement';
import { Wind } from './engine/tiles';
import { SeatInfo, TableController } from './game/controller';
import { normalizeRoomId, RoomSettings } from './net/protocol';
import { loadPrefs, Prefs, savePrefs, withDefaults } from './ui/prefs';
import { confirmBox, createRoom, joinRoom, loadHostSnapshot, offlineJoin, pruneStorage, resumeHost, RoomContext } from './ui/room';
import { settingsScreen } from './ui/settings';
import { TableScreen, rulesDialog } from './ui/table';
import { esc, loadSkin, setSkin, Skin, skinPickerHtml, tileSrc } from './ui/tiles';
import { autoFullscreen, canFullscreen, canInstall, initInstallPrompt, install, isIos, isStandalone, onInstallChange } from './ui/fullscreen';

const app = document.getElementById('app')!;
let prefs: Prefs = loadPrefs();
let cleanup: (() => void) | null = null;

const LEVEL_NAME = { easy: '簡單', normal: '普通', hard: '困難' } as const;
const AI_NAMES = ['阿土伯', '小美', '錢夫人', '阿華', '孫小美', '大老李'];

function go(screen: () => void) {
  cleanup?.();
  cleanup = null;
  screen();
}

const roomCtx = (): RoomContext => ({
  app,
  nickname: prefs.nickname,
  tingHint: prefs.tingHint,
  goHome: () => go(home),
  setCleanup: (fn) => {
    cleanup = fn;
  },
});

// ---------------------------------------------------------------- 首頁

function home() {
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  const deco = [31, 0, 32, 18, 33].map((k) => `<img src="${tileSrc(k)}" alt="">`).join('');
  app.innerHTML = `<div class="screen home">
    <div class="home-card">
      <div class="deco">${deco}</div>
      <h1>台灣麻將</h1>
      <p class="sub">16 張・純娛樂</p>
      <label class="field"><span>暱稱</span><input id="nick" maxlength="10" placeholder="輸入 1–10 個字" value="${esc(prefs.nickname)}"></label>
      <div class="home-buttons">
        <button class="btn big" id="open-room">開房間<small>分享網址，找朋友一起打</small></button>
        <button class="btn big primary" id="solo">單人對 AI<small>自己跟三位 AI 打</small></button>
      </div>
      <div class="join-row">
        <input id="code" maxlength="6" placeholder="輸入房號加入" autocapitalize="characters" autocomplete="off">
        <button class="btn" id="join">加入</button>
      </div>
      <p class="error-line" id="err"></p>
      <button class="btn small-btn" id="scan-join">掃描加入（同 Wi-Fi 離線房間）</button>
      <div class="home-links"><button class="link" id="rules">台數表與規則</button><button class="link" id="skin">換風格</button></div>
      <div class="install" id="install"></div>
      <p class="disclaimer">純娛樂，不涉及任何金錢，分數不可兌換。</p>
    </div>
  </div>`;
  const nick = app.querySelector<HTMLInputElement>('#nick')!;
  const saveNick = () => {
    prefs.nickname = nick.value.trim().slice(0, 10);
    savePrefs(prefs);
  };
  nick.addEventListener('change', saveNick);
  app.querySelector('#solo')!.addEventListener('click', () => {
    saveNick();
    go(soloSetup);
  });
  app.querySelector('#open-room')!.addEventListener('click', () => {
    saveNick();
    go(roomSetup);
  });
  const code = app.querySelector<HTMLInputElement>('#code')!;
  const join = () => {
    saveNick();
    const id = normalizeRoomId(code.value);
    if (id.length !== 6) {
      app.querySelector('#err')!.textContent = '房號是 6 個英文字母或數字';
      return;
    }
    autoFullscreen();
    go(() => joinRoom(roomCtx(), id));
  };
  app.querySelector('#join')!.addEventListener('click', join);
  app.querySelector('#scan-join')!.addEventListener('click', () => {
    saveNick();
    autoFullscreen();
    go(() => void offlineJoin(roomCtx()));
  });
  code.addEventListener('keydown', (e) => e.key === 'Enter' && join());
  const inst = app.querySelector<HTMLElement>('#install')!;
  const drawInstall = () => {
    if (isStandalone()) inst.innerHTML = '';
    else if (canInstall()) inst.innerHTML = `<button class="btn small-btn" id="do-install">安裝到主畫面（可全螢幕、離線玩單人）</button>`;
    else if (isIos()) inst.innerHTML = `<p class="muted small">iPhone 想全螢幕玩：點 Safari 下方的「分享」→「加入主畫面」，再從主畫面開啟。</p>`;
    else if (!canFullscreen()) inst.innerHTML = '';
    else inst.innerHTML = '';
    inst.querySelector('#do-install')?.addEventListener('click', () => void install().then(drawInstall));
  };
  drawInstall();
  const offInstall = onInstallChange(drawInstall);
  cleanup = () => offInstall();
  app.querySelector('#skin')!.addEventListener('click', () => {
    const wrap = document.createElement('div');
    const draw = () => {
      wrap.innerHTML = `<div class="overlay" data-close><div class="dialog skin-dialog"><h2>選擇風格</h2>
        <p class="muted small">牌面、牌背與牌桌會一起換；開房時每位玩家各自選，互不影響。遊戲中也可以按「風格」切換。</p>
        ${skinPickerHtml()}<div class="dialog-buttons"><button class="btn" data-close>關閉</button></div></div></div>`;
    };
    draw();
    app.appendChild(wrap);
    wrap.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const pick = t.closest<HTMLElement>('[data-pick-skin]');
      if (pick) {
        setSkin(pick.dataset.pickSkin as Skin);
        go(home);
        return;
      }
      if (t.hasAttribute('data-close')) wrap.remove();
    });
  });
  app.querySelector('#rules')!.addEventListener('click', () => {
    const wrap = document.createElement('div');
    wrap.innerHTML = rulesDialog();
    app.appendChild(wrap);
    wrap.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
      if (el?.dataset.act === 'closerules') wrap.remove();
    });
  });
}

// ---------------------------------------------------------------- 設定

function soloSetup() {
  settingsScreen(app, {
    title: '單人對 AI', values: withDefaults(prefs.solo), tingHint: prefs.tingHint, submitLabel: '開始', levelLabel: 'AI 難度',
    onBack: () => go(home),
    onSubmit: (values, ting) => {
      autoFullscreen();
      prefs.solo = values;
      prefs.tingHint = ting;
      savePrefs(prefs);
      go(soloGame);
    },
  });
}

function roomSetup() {
  settingsScreen(app, {
    title: '開房間', values: withDefaults(prefs.room ?? prefs.solo), tingHint: prefs.tingHint, submitLabel: '建立房間', levelLabel: '補位 AI',
    connection: navigator.onLine ? 'online' : 'offline',
    onBack: () => go(home),
    onSubmit: (values: RoomSettings, ting, connection) => {
      autoFullscreen();
      prefs.room = values;
      prefs.tingHint = ting;
      savePrefs(prefs);
      go(() => void createRoom(roomCtx(), values, connection === 'offline'));
    },
  });
}

/** 從網址進來：#/r/房號。房主重開分頁時從快照恢復，其他人加入房間 */
function nicknameThen(id: string) {
  app.innerHTML = `<div class="screen home"><div class="home-card">
    <h2>加入房間 ${esc(id)}</h2>
    <label class="field"><span>暱稱</span><input id="nick" maxlength="10" placeholder="輸入 1–10 個字" value="${esc(prefs.nickname)}"></label>
    <div class="dialog-buttons"><button class="btn" id="home">回首頁</button><button class="btn primary" id="go">加入</button></div>
  </div></div>`;
  const nick = app.querySelector<HTMLInputElement>('#nick')!;
  nick.focus();
  const goJoin = () => {
    autoFullscreen();
    prefs.nickname = nick.value.trim().slice(0, 10);
    savePrefs(prefs);
    go(() => joinRoom(roomCtx(), id));
  };
  app.querySelector('#go')!.addEventListener('click', goJoin);
  nick.addEventListener('keydown', (e) => e.key === 'Enter' && goJoin());
  app.querySelector('#home')!.addEventListener('click', () => go(home));
}

function route() {
  const m = location.hash.match(/^#\/r\/([A-Za-z0-9]{6})$/);
  if (!m) return go(home);
  const id = normalizeRoomId(m[1]);
  const snap = loadHostSnapshot(id);
  if (snap) return go(() => void resumeHost(roomCtx(), snap));
  if (!prefs.nickname) return go(() => nicknameThen(id));
  go(() => joinRoom(roomCtx(), id));
}

// ---------------------------------------------------------------- 單人對局

function soloGame() {
  const s = withDefaults(prefs.solo);
  const rules: GameRules = {
    ...DEFAULT_RULES,
    rounds: s.rounds,
    multiWin: s.multiWin,
    score: { ...DEFAULT_SCORE_RULES, base: s.base, perTai: s.perTai, leopardDouble: s.leopardDouble },
  };
  // 擲骰決定座位：玩家隨機坐在四個位置之一（座位 0 為首局莊家）
  const humanSeat = Math.floor(Math.random() * 4) as Wind;
  const names = [...AI_NAMES].sort(() => Math.random() - 0.5);
  const seats: SeatInfo[] = [0, 1, 2, 3].map((i) =>
    i === humanSeat
      ? { name: prefs.nickname || '我', kind: 'human' }
      : { name: `${names.pop()}・${LEVEL_NAME[s.level]}`, kind: 'ai', level: s.level },
  );
  const timer = { discardSeconds: s.discardSeconds, claimSeconds: s.claimSeconds ?? 8, autoLevel: s.autoLevel ?? 'hard' };
  // 網址加上 ?fast 可讓 AI 快速出牌（測試用）
  const fast = new URLSearchParams(location.search).has('fast');
  const ctl = new TableController(rules, seats, timer, undefined, fast ? [40, 80] : undefined);
  app.innerHTML = `<div class="screen game"></div>`;
  const screen = new TableScreen(app.firstElementChild as HTMLElement, {
    act: (a) => ctl.act(humanSeat, a),
    nextHand: () => ctl.act(null, { type: 'nextHand' }),
    togglePause: () => ctl.setPaused(!ctl.paused),
    takeBack: () => ctl.takeBack(humanSeat),
    setAutoTing: (on) => ctl.setAutoTing(humanSeat, on),
    leave: () => {
      if (ctl.state.phase.kind === 'matchOver') return go(home);
      const wasPaused = ctl.paused;
      if (!wasPaused) ctl.setPaused(true);
      confirmBox('離開這一將？', '目前的分數不會保存。', '離開', () => go(home), () => {
        if (!wasPaused) ctl.setPaused(false);
      });
    },
    restart: () => go(soloGame),
  }, { tingHint: prefs.tingHint, role: 'solo' });
  const draw = () => screen.render(ctl.viewFor(humanSeat));
  const unsub = ctl.subscribe(draw);
  draw();
  cleanup = () => {
    unsub();
    ctl.destroy();
    screen.destroy();
  };
}

initInstallPrompt();
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  // 離線快取：開過一次後沒有網路也能開啟（規格書 FR-13）
  window.addEventListener('load', () => void navigator.serviceWorker.register('./sw.js').catch(() => undefined));
}
setSkin(loadSkin());
pruneStorage();
window.addEventListener('hashchange', route);
route();
