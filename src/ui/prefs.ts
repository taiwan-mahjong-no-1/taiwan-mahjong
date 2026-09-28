/** 存在瀏覽器裡的個人偏好；讀寫失敗（無痕模式等）時用預設值 */
export interface Prefs {
  nickname: string;
  tingHint: boolean;
  solo: {
    level: 'easy' | 'normal' | 'hard';
    rounds: 1 | 4;
    base: number;
    perTai: number;
    discardSeconds: number;
    claimSeconds?: number;
    autoLevel?: 'easy' | 'normal' | 'hard';
    allowAssist?: boolean;
    multiWin: boolean;
    leopardDouble: boolean;
  };
  /** 上次開房用的設定 */
  room?: Prefs['solo'];
}

const KEY = 'taiwan-mahjong:prefs';
const DEFAULTS: Prefs = {
  nickname: '',
  tingHint: true,
  solo: {
    level: 'normal', rounds: 1, base: 30, perTai: 10, discardSeconds: 15, claimSeconds: 8, autoLevel: 'hard',
    multiWin: false, leopardDouble: true,
  },
};

/** 補上舊版存檔沒有的新欄位 */
export const withDefaults = (s: Prefs['solo']): Prefs['solo'] => ({ ...DEFAULTS.solo, ...s });

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const p = JSON.parse(raw);
    return { ...DEFAULTS, ...p, solo: { ...DEFAULTS.solo, ...(p.solo ?? {}) } };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* 無法儲存時略過 */
  }
}
