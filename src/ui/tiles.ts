import { kindOf, TileId } from '../engine/game';
import { TileKind, tileName } from '../engine/tiles';

export const FILES: string[] = [
  ...Array.from({ length: 9 }, (_, i) => `m${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `p${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `s${i + 1}`),
  'wind_e', 'wind_s', 'wind_w', 'wind_n', 'dragon_red', 'dragon_green', 'dragon_white',
  ...Array.from({ length: 8 }, (_, i) => `flower_${i + 1}`),
];

/** 牌與牌桌的風格：每位玩家自己選，只影響自己的畫面 */
export type Skin = 'classic' | 'yellow' | 'black' | 'chips';
export const SKINS: { id: Skin; name: string; desc: string }[] = [
  { id: 'classic', name: '預設', desc: '綠色牌背・綠色牌桌' },
  { id: 'yellow', name: '黃色', desc: '黃色牌背（包子寶寶）・藍色牌桌' },
  { id: 'black', name: '黑色', desc: '黑色牌背（貓頭鷹）・酒紅牌桌' },
  { id: 'chips', name: '薯片', desc: '檸檬黃牌背（薯片妹）・粉紅牌桌' },
];

const BASE = `${import.meta.env.BASE_URL}assets/`;
let skin: Skin = 'classic';
const dir = (s: Skin = skin) => (s === 'classic' ? BASE : `${BASE}skins/${s}/`);

export const tileSrc = (k: TileKind, s: Skin = skin) => `${dir(s)}tiles/svg/${FILES[k]}.svg`;
export const backSrcOf = (s: Skin = skin) => `${dir(s)}tiles/svg/back.svg`;
export const standingSrcOf = (s: Skin = skin) => `${dir(s)}tiles/svg/standing_back.svg`;
export const tableBgOf = (s: Skin = skin) => `${dir(s)}table/table_bg.svg`;
export const uiSrc = (name: string) => `${BASE}ui/svg/${name}.svg`;

export function getSkin(): Skin {
  return skin;
}

const SKIN_KEY = 'taiwan-mahjong:skin';

/** 讀取上次選的風格 */
export function loadSkin(): Skin {
  try {
    return (localStorage.getItem(SKIN_KEY) as Skin) || 'classic';
  } catch {
    return 'classic';
  }
}

/** 換風格：更新牌桌背景與配色，並預先載入新牌面 */
export function setSkin(s: Skin) {
  skin = SKINS.some((x) => x.id === s) ? s : 'classic';
  try {
    localStorage.setItem(SKIN_KEY, skin);
  } catch {
    /* 無法儲存時略過 */
  }
  const root = document.documentElement;
  root.dataset.skin = skin;
  root.style.setProperty('--table-bg', `url("${tableBgOf()}")`);
  preloadTiles();
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** 牌面 HTML；id 為 -1 表示牌背 */
export function tileHtml(id: TileId, cls = '', attrs = ''): string {
  if (id < 0) return `<img class="tile ${cls}" src="${backSrcOf()}" alt="牌背" draggable="false" ${attrs}>`;
  const k = kindOf(id);
  return `<img class="tile ${cls}" src="${tileSrc(k)}" alt="${tileName(k)}" draggable="false" ${attrs}>`;
}

export function kindHtml(k: TileKind, cls = ''): string {
  return `<img class="tile ${cls}" src="${tileSrc(k)}" alt="${tileName(k)}" draggable="false">`;
}

/** 預先載入目前風格的所有牌面，避免第一次出現時閃爍 */
export function preloadTiles() {
  for (const f of [...FILES.map((_, k) => tileSrc(k)), backSrcOf(), standingSrcOf(), tableBgOf()]) {
    const img = new Image();
    img.src = f;
  }
}

/** 風格選擇對話框的內容 */
export function skinPickerHtml(): string {
  return `<div class="skin-list">${SKINS.map((s) => `
    <button class="skin-card${s.id === skin ? ' on' : ''}" data-pick-skin="${s.id}">
      <span class="skin-preview" style="background-image:url('${tableBgOf(s.id)}')">
        <img src="${tileSrc(31, s.id)}" alt=""><img src="${tileSrc(18, s.id)}" alt=""><img src="${backSrcOf(s.id)}" alt="">
      </span>
      <b>${s.name}</b><small>${s.desc}</small>
    </button>`).join('')}</div>`;
}
