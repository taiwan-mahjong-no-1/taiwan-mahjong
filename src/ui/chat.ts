/**
 * 開房聊天：「聊天」按鈕打開聊天紀錄視窗，可以自由打字或點快捷語。
 * 等待畫面用右上角的浮動按鈕；牌局中按鈕放在牌桌上方工具列（由 TableScreen 畫，見 chatButtonHtml）。
 * 視窗掛在 body 上、不在牌桌裡，牌桌整個重畫時打到一半的字不會不見。
 */
import { CHAT_GAP_MS, CHAT_MAX_LEN, ChatMsg } from '../net/protocol';
import { esc } from './tiles';

export const QUICK_PHRASES = ['快一點啦～', '讚啦！', '等我一下', '歹勢歹勢', '哈哈哈', '這把穩了', '手氣也太好', '再來一將！'];

const ROLE_TAG: Record<ChatMsg['role'], string> = { host: '房主', player: '', spectator: '旁觀' };
const hhmm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 牌桌工具列上的聊天按鈕（未讀數由 ChatPanel 更新） */
export function chatButtonHtml(unread: number): string {
  return `<button class="icon-btn chat-btn" data-act="chat" title="聊天">聊天<span class="chat-badge" data-chat-badge${unread ? '' : ' hidden'}>${unread > 9 ? '9+' : unread}</span></button>`;
}

export class ChatPanel {
  private el: HTMLElement;
  private open = false;
  private msgs: ChatMsg[] = [];
  /** 看過的最後一則；之後別人發的算未讀 */
  private seenId = 0;
  private lastSent = 0;
  /** 視窗開著時定時調整高度，不蓋到自己的手牌與吃碰槓按鈕 */
  private fitTimer?: ReturnType<typeof setInterval>;

  constructor(private send: (text: string) => void) {
    this.el = document.createElement('div');
    this.el.id = 'chat';
    this.el.innerHTML = `<button class="chat-fab" data-chat="toggle" aria-label="聊天">聊天<span class="chat-badge" hidden></span></button>
      <div class="chat-panel" hidden role="dialog" aria-label="聊天">
        <div class="chat-head"><b>聊天</b><button class="icon-btn" data-chat="close" aria-label="關閉聊天">✕</button></div>
        <div class="chat-list"></div>
        <div class="chat-quick">${QUICK_PHRASES.map((p) => `<button class="chat-chip" data-quick="${esc(p)}">${esc(p)}</button>`).join('')}</div>
        <form class="chat-form"><input class="chat-input" maxlength="${CHAT_MAX_LEN}" placeholder="輸入訊息…" enterkeyhint="send" autocomplete="off"><button class="btn primary" type="submit">送出</button></form>
      </div>`;
    document.body.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const act = t.closest<HTMLElement>('[data-chat]')?.dataset.chat;
      if (act === 'toggle') this.setOpen(!this.open);
      else if (act === 'close') this.setOpen(false);
      const quick = t.closest<HTMLElement>('[data-quick]')?.dataset.quick;
      if (quick) this.submit(quick);
    });
    this.el.querySelector('form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = this.el.querySelector<HTMLInputElement>('.chat-input')!;
      if (this.submit(input.value)) input.value = '';
    });
  }

  get unread(): number {
    return this.msgs.filter((m) => m.id > this.seenId && !m.mine).length;
  }

  toggle() {
    this.setOpen(!this.open);
  }

  /** 更新聊天紀錄（整份換掉） */
  set(msgs: ChatMsg[]) {
    this.msgs = msgs;
    if (this.open) this.markSeen();
    this.draw();
  }

  destroy() {
    clearInterval(this.fitTimer);
    this.el.remove();
  }

  /** 牌局中：視窗底部停在自己手牌區（含吃碰槓按鈕、提示）上方；等待畫面不限制 */
  private fit() {
    const panel = this.el.querySelector<HTMLElement>('.chat-panel')!;
    const me = document.querySelector<HTMLElement>('.table .me');
    if (!me) {
      panel.style.bottom = '';
      return;
    }
    const top = me.getBoundingClientRect().top;
    // .me 本身撐滿整列，從第一個看得到的子元素算起
    const first = [...me.children].map((c) => c.getBoundingClientRect()).filter((r) => r.height > 0);
    const edge = first.length ? Math.min(...first.map((r) => r.top)) : top;
    panel.style.bottom = `${Math.max(8, window.innerHeight - edge + 6)}px`;
  }

  private submit(raw: string): boolean {
    const text = raw.trim();
    // 房主那邊也會擋太快的訊息；這裡先擋，免得送出後沒出現
    if (!text || Date.now() - this.lastSent < CHAT_GAP_MS) return false;
    this.lastSent = Date.now();
    this.send(text);
    return true;
  }

  private setOpen(open: boolean) {
    this.open = open;
    this.el.querySelector<HTMLElement>('.chat-panel')!.hidden = !open;
    clearInterval(this.fitTimer);
    if (open) {
      this.fit();
      this.fitTimer = setInterval(() => this.fit(), 300);
      this.markSeen();
      // 手機打開時不自動跳出鍵盤，電腦直接可以打字
      if (matchMedia('(pointer: fine)').matches) this.el.querySelector<HTMLInputElement>('.chat-input')!.focus();
    }
    this.draw();
  }

  private markSeen() {
    this.seenId = this.msgs.length ? this.msgs[this.msgs.length - 1].id : this.seenId;
  }

  private draw() {
    const unread = this.unread;
    // 浮動按鈕和牌桌工具列上的按鈕都更新
    for (const badge of document.querySelectorAll<HTMLElement>('.chat-badge')) {
      badge.hidden = unread === 0;
      badge.textContent = unread > 9 ? '9+' : String(unread);
    }
    if (!this.open) return;
    const list = this.el.querySelector<HTMLElement>('.chat-list')!;
    list.innerHTML = this.msgs.length
      ? this.msgs.map((m) => {
          const tag = ROLE_TAG[m.role] ? `<span class="tag">${ROLE_TAG[m.role]}</span>` : '';
          return `<div class="chat-msg${m.mine ? ' mine' : ''}">
            <div class="chat-meta">${m.mine ? '' : `<b>${esc(m.name)}</b>${tag}`}<span>${hhmm(m.at)}</span></div>
            <div class="chat-text">${esc(m.text)}</div></div>`;
        }).join('')
      : '<p class="muted small chat-empty">還沒有人說話，打聲招呼吧！</p>';
    list.scrollTop = list.scrollHeight;
  }
}
