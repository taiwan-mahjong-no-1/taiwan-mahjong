/**
 * 可重現的亂數（sfc32）。正式對局由房主以 crypto.getRandomValues 產生種子，
 * 測試與回放則用固定種子，同一個種子一定洗出同一副牌。
 */
export type Rng = () => number;

export function createRng(seed: number): Rng {
  let a = 0x9e3779b9 ^ seed;
  let b = 0x243f6a88 ^ (seed * 31);
  let c = 0xb7e15162 ^ (seed * 17);
  let d = seed | 0;
  const next = () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 16; i++) next();
  return next;
}

export function randomSeed(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0];
}

export function shuffle<T>(arr: T[], rng: Rng): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export const rollDie = (rng: Rng) => 1 + Math.floor(rng() * 6);
