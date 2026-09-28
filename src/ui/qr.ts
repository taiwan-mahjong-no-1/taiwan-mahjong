/** QR code 顯示與相機掃描（離線開房用） */
import QRCode from 'qrcode';
import { esc } from './tiles';

export interface QrDialog {
  close(): void;
  setStatus(html: string): void;
}

/** 顯示一個大 QR code，下方附文字代碼（沒有相機時可複製貼上） */
export function showQrDialog(o: {
  title: string;
  steps: string[];
  code: string;
  buttons: { id: string; label: string; primary?: boolean; onClick: () => void }[];
}): QrDialog {
  const el = document.createElement('div');
  el.className = 'overlay qr-overlay';
  el.innerHTML = `<div class="dialog qr-dialog">
    <h2>${o.title}</h2>
    <div class="qr-body">
      <canvas class="qr-big"></canvas>
      <div class="qr-side">
        <ol class="qr-steps">${o.steps.map((s) => `<li>${s}</li>`).join('')}</ol>
        <div class="qr-status"></div>
        <details class="qr-code-text"><summary>沒有相機？改用文字代碼</summary>
          <textarea readonly rows="3">${esc(o.code)}</textarea>
          <button class="btn small-btn" data-copy>複製代碼</button>
        </details>
        <div class="dialog-buttons">${o.buttons.map((b) => `<button class="btn${b.primary ? ' primary' : ''}" data-b="${b.id}">${b.label}</button>`).join('')}</div>
      </div>
    </div>
  </div>`;
  document.body.appendChild(el);
  const canvas = el.querySelector<HTMLCanvasElement>('.qr-big')!;
  const size = Math.min(280, Math.floor(Math.min(window.innerWidth * 0.42, window.innerHeight * 0.62)));
  void QRCode.toCanvas(canvas, o.code, { width: size, margin: 2, errorCorrectionLevel: 'L' });
  el.querySelector('[data-copy]')!.addEventListener('click', (e) => {
    const ta = el.querySelector('textarea')!;
    ta.select();
    void navigator.clipboard?.writeText(o.code).then(() => ((e.target as HTMLElement).textContent = '已複製'));
  });
  for (const b of o.buttons) el.querySelector(`[data-b="${b.id}"]`)!.addEventListener('click', b.onClick);
  return {
    close: () => el.remove(),
    setStatus: (html) => (el.querySelector('.qr-status')!.innerHTML = html),
  };
}

/**
 * 開相機掃描 QR code；沒有相機或拒絕授權時可以貼上文字代碼。
 * 回傳掃到的文字；按取消回傳 null。
 */
export function scanQr(o: { title: string; hint: string; accept?: (text: string) => boolean }): Promise<string | null> {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'overlay qr-overlay';
    el.innerHTML = `<div class="dialog qr-dialog scan">
      <h2>${o.title}</h2>
      <div class="qr-body">
        <div class="scan-view"><video playsinline muted></video><div class="scan-frame"></div><div class="scan-msg">開啟相機中…</div></div>
        <div class="qr-side">
          <p>${o.hint}</p>
          <details class="qr-code-text"><summary>沒有相機？貼上文字代碼</summary>
            <textarea rows="3" placeholder="貼上對方的代碼"></textarea>
            <button class="btn small-btn" data-paste>使用這段代碼</button>
          </details>
          <p class="error-line"></p>
          <div class="dialog-buttons"><button class="btn" data-cancel>取消</button></div>
        </div>
      </div>
    </div>`;
    document.body.appendChild(el);
    const video = el.querySelector('video')!;
    const msg = el.querySelector<HTMLElement>('.scan-msg')!;
    const err = el.querySelector<HTMLElement>('.error-line')!;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    let done = false;
    const finish = (text: string | null) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
      el.remove();
      resolve(text);
    };
    const tryText = (text: string) => {
      const t = text.trim();
      if (o.accept && !o.accept(t)) {
        err.textContent = '這不是需要的 QR code，請再試一次';
        return;
      }
      finish(t);
    };
    el.querySelector('[data-cancel]')!.addEventListener('click', () => finish(null));
    el.querySelector('[data-paste]')!.addEventListener('click', () => tryText(el.querySelector('textarea')!.value));

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      } catch {
        msg.textContent = '無法開啟相機，請改用下方的文字代碼';
        return;
      }
      if (done) return stream.getTracks().forEach((t) => t.stop());
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      msg.textContent = '把 QR code 對準框框';
      const { default: jsQR } = await import('jsqr');
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      timer = setInterval(() => {
        if (!video.videoWidth) return;
        const scale = Math.min(1, 640 / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (hit?.data) tryText(hit.data);
      }, 200);
    })();
  });
}
