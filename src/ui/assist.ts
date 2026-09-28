/** 輔助模式設定：每位玩家自己選，存在自己的瀏覽器 */
import type { AiLevel } from '../ai/ai';

export type AssistLevel = 'off' | Exclude<AiLevel, never>;
const KEY = 'taiwan-mahjong:assist';

export function loadAssist(): AssistLevel {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'easy' || v === 'normal' || v === 'hard' ? v : 'off';
  } catch {
    return 'off';
  }
}

export function saveAssist(v: AssistLevel) {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* 無法儲存時略過 */
  }
}
