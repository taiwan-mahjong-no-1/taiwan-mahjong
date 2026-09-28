/** 牌局設定表單：單人模式與開房共用 */
import { RoomSettings } from '../net/protocol';

export interface SettingsFormOptions {
  title: string;
  values: RoomSettings;
  tingHint: boolean;
  submitLabel: string;
  /** 開房時 AI 難度是「空位補上的 AI」 */
  levelLabel: string;
  /** 開房時選擇連線方式 */
  connection?: 'online' | 'offline';
  onSubmit(values: RoomSettings, tingHint: boolean, connection: 'online' | 'offline'): void;
  onBack(): void;
}

export function settingsScreen(app: HTMLElement, o: SettingsFormOptions) {
  const s = o.values;
  const opt = <T extends string | number | boolean>(name: string, options: [T, string][], cur: T) =>
    `<div class="seg" data-name="${name}">${options.map(([val, label]) =>
      `<button class="seg-btn${val === cur ? ' on' : ''}" data-val="${String(val)}">${label}</button>`).join('')}</div>`;
  app.innerHTML = `<div class="screen setup">
    <div class="setup-card">
      <h2>${o.title}</h2>
      <div class="form">
        ${o.connection ? `<label>連線方式</label>${opt('connection', [['online', '網路（分享網址）'], ['offline', '同 Wi-Fi 離線']], o.connection)}` : ''}
        <label>${o.levelLabel}</label>${opt('level', [['easy', '簡單'], ['normal', '普通'], ['hard', '困難']], s.level)}
        <label>圈數</label>${opt('rounds', [[1, '一圈'], [4, '四圈（一將）']], s.rounds)}
        <label>底</label><input type="number" id="base" min="0" max="10000" inputmode="numeric" value="${s.base}">
        <label>每台</label><input type="number" id="perTai" min="1" max="10000" inputmode="numeric" value="${s.perTai}">
        <label>思考時間</label>${opt('discardSeconds', [[15, '15 秒'], [30, '30 秒'], [0, '不限時']], s.discardSeconds)}
        <label>吃碰槓時間</label>${opt('claimSeconds', [[5, '5 秒'], [8, '8 秒'], [10, '10 秒'], [15, '15 秒'], [0, '不限時']], s.claimSeconds ?? 8)}
        <label>代打強度</label>${opt('autoLevel', [['easy', '簡單'], ['normal', '普通'], ['hard', '困難']], s.autoLevel ?? 'hard')}
        <label>同時胡牌</label>${opt('multiWin', [[false, '截胡'], [true, '一炮多響']], s.multiWin)}
        <label>豹子加倍</label>${opt('leopardDouble', [[true, '開'], [false, '關']], s.leopardDouble)}
        <label>聽牌提示</label>${opt('tingHint', [[true, '開'], [false, '關']], o.tingHint)}
        ${o.connection ? `<label>AI 提示</label>${opt('allowAssist', [[true, '允許'], [false, '禁止']], s.allowAssist ?? true)}` : ''}
      </div>
      <div class="dialog-buttons">
        <button class="btn" id="back">返回</button>
        <button class="btn primary" id="start">${o.submitLabel}</button>
      </div>
    </div>
  </div>`;
  app.querySelectorAll<HTMLElement>('.seg').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('.seg-btn');
      if (!b) return;
      seg.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
    });
  });
  app.querySelector('#back')!.addEventListener('click', () => o.onBack());
  app.querySelector('#start')!.addEventListener('click', () => {
    const val = (name: string) => app.querySelector<HTMLElement>(`.seg[data-name="${name}"] .on`)!.dataset.val!;
    const num = (id: string, d: number) => {
      const n = Math.round(Number(app.querySelector<HTMLInputElement>(`#${id}`)!.value));
      return Number.isFinite(n) && n >= 0 ? Math.min(n, 100000) : d;
    };
    o.onSubmit({
      level: val('level') as RoomSettings['level'],
      rounds: Number(val('rounds')) as 1 | 4,
      base: num('base', 30),
      perTai: Math.max(1, num('perTai', 10)),
      discardSeconds: Number(val('discardSeconds')),
      claimSeconds: Number(val('claimSeconds')),
      autoLevel: val('autoLevel') as RoomSettings['level'],
      multiWin: val('multiWin') === 'true',
      leopardDouble: val('leopardDouble') === 'true',
      // 單人模式沒有這個選項，一律允許
      allowAssist: o.connection ? val('allowAssist') === 'true' : true,
    }, val('tingHint') === 'true', o.connection ? (val('connection') as 'online' | 'offline') : 'online');
  });
}

export function settingsSummary(s: RoomSettings): string {
  const names = { easy: '簡單', normal: '普通', hard: '困難' };
  const lv = names[s.level];
  const claim = s.claimSeconds ?? 8;
  return [
    s.rounds === 1 ? '一圈' : '四圈',
    `底 ${s.base}／每台 ${s.perTai}`,
    s.discardSeconds ? `思考 ${s.discardSeconds} 秒` : '思考不限時',
    claim ? `吃碰槓 ${claim} 秒` : '吃碰槓不限時',
    s.multiWin ? '一炮多響' : '截胡',
    s.leopardDouble ? '豹子加倍' : '豹子不加倍',
    `補位 AI：${lv}`,
    `代打：${names[s.autoLevel ?? 'hard']}`,
    s.allowAssist === false ? '禁止 AI 提示' : '允許 AI 提示',
  ].join('・');
}
