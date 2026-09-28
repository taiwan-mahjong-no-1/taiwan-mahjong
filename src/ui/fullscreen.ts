/**
 * 手機全螢幕（規格書 4.3）：
 * - Android、電腦：用瀏覽器的全螢幕功能，並鎖定橫向
 * - iPhone：Safari 不支援網頁全螢幕，改用「加入主畫面」後以 App 方式開啟
 */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

let installEvent: InstallPromptEvent | null = null;
const installListeners = new Set<() => void>();

export function initInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvent = e as InstallPromptEvent;
    installListeners.forEach((f) => f());
  });
  window.addEventListener('appinstalled', () => {
    installEvent = null;
    installListeners.forEach((f) => f());
  });
}

export const onInstallChange = (f: () => void) => {
  installListeners.add(f);
  return () => installListeners.delete(f);
};
export const canInstall = () => installEvent !== null;
export async function install() {
  await installEvent?.prompt();
  installEvent = null;
}

export const canFullscreen = () => !!document.documentElement.requestFullscreen && !!document.fullscreenEnabled;
export const isFullscreen = () => !!document.fullscreenElement;
export const isStandalone = () =>
  matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;
export const isTouch = () => matchMedia('(pointer: coarse)').matches;
export const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export async function enterFullscreen() {
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    await o.lock?.('landscape').catch(() => undefined);
  } catch {
    /* 使用者拒絕或瀏覽器不支援 */
  }
}

export async function toggleFullscreen() {
  if (isFullscreen()) await document.exitFullscreen().catch(() => undefined);
  else await enterFullscreen();
}

/** 手機上開局時自動進入全螢幕（必須在點擊事件中呼叫） */
export function autoFullscreen() {
  if (isTouch() && canFullscreen() && !isStandalone() && !isFullscreen()) void enterFullscreen();
}
