import { Link } from './protocol';

/** 記憶體中的一對連線，測試用；訊息經過 JSON 來回，確保可以序列化 */
export function memoryPair<A, B>(): [Link<A, B>, Link<B, A>] {
  const handlers: [((m: unknown) => void)[], ((m: unknown) => void)[]] = [[], []];
  const closers: [(() => void)[], (() => void)[]] = [[], []];
  let closed = false;
  const make = (side: 0 | 1) => ({
    send(msg: unknown) {
      if (closed) return;
      const copy = JSON.parse(JSON.stringify(msg));
      queueMicrotask(() => {
        if (!closed) handlers[1 - side].forEach((h) => h(copy));
      });
    },
    onMessage(cb: (m: never) => void) {
      handlers[side].push(cb as (m: unknown) => void);
    },
    onClose(cb: () => void) {
      closers[side].push(cb);
    },
    close() {
      if (closed) return;
      closed = true;
      queueMicrotask(() => {
        closers[0].forEach((c) => c());
        closers[1].forEach((c) => c());
      });
    },
  });
  return [make(0) as Link<A, B>, make(1) as Link<B, A>];
}
