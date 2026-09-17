import type { Pt } from '../landmarks';

export type PredictMethod = 'polarAccel' | 'polarVel' | 'cartAccel' | 'cartVel';

export interface InertiaState {
  /** 桿頭線速度（px/s） */
  vx: number;
  vy: number;
  /** 桿頭線加速度（px/s²） */
  ax: number;
  ay: number;
  /** 以雙手為圓心的角速度（rad/s）與角加速度（rad/s²） */
  omega: number;
  alpha: number;
  /** 預測的下一格位置 */
  next: Pt;
}

const wrap = (d: number) => {
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
};

/**
 * 以慣性（只用目前與過去的格）推估下一格的桿頭位置。
 * - polar：桿頭繞雙手旋轉，以角速度／角加速度外推角度，長度與雙手位置各自線性外推
 * - cart：直角座標的等速／等加速度外推
 * @param club 桿頭位置（px），缺值為 null
 * @param hands 雙手位置（px）
 * @param f 目前格
 * @param dtNext 到下一格的時間（秒）；未知時用前一格間距
 */
export function predictNext(
  club: (Pt | null)[],
  hands: Pt[],
  t: ArrayLike<number>,
  f: number,
  method: PredictMethod = 'polarAccel',
  dtNext?: number,
): InertiaState | null {
  const p0 = club[f];
  const p1 = club[f - 1];
  if (!p0 || !p1 || f < 1) return null;
  const p2 = f >= 2 ? club[f - 2] : null;
  const dt1 = Math.max(t[f] - t[f - 1], 1e-6);
  const dt2 = f >= 2 ? Math.max(t[f - 1] - t[f - 2], 1e-6) : dt1;
  const dn = dtNext ?? dt1;
  const useAccel = (method === 'polarAccel' || method === 'cartAccel') && !!p2;

  // 後向差分得到的是前後兩格「中點」的速度
  let vx = (p0.x - p1.x) / dt1;
  let vy = (p0.y - p1.y) / dt1;
  let ax = 0;
  let ay = 0;
  if (p2) {
    const span = (dt1 + dt2) / 2;
    ax = (vx - (p1.x - p2.x) / dt2) / span;
    ay = (vy - (p1.y - p2.y) / dt2) / span;
    // 修正到目前這格的瞬時速度
    vx += (ax * dt1) / 2;
    vy += (ay * dt1) / 2;
  }

  const h0 = hands[f];
  const h1 = hands[f - 1];
  const th0 = Math.atan2(p0.y - h0.y, p0.x - h0.x);
  const th1 = Math.atan2(p1.y - h1.y, p1.x - h1.x);
  let omega = wrap(th0 - th1) / dt1;
  let alpha = 0;
  if (p2 && f >= 2) {
    const h2 = hands[f - 2];
    const th2 = Math.atan2(p2.y - h2.y, p2.x - h2.x);
    alpha = (omega - wrap(th1 - th2) / dt2) / ((dt1 + dt2) / 2);
    omega += (alpha * dt1) / 2;
  }

  let next: Pt;
  if (method === 'cartVel' || method === 'cartAccel') {
    next = useAccel
      ? { x: p0.x + vx * dn + 0.5 * ax * dn * dn, y: p0.y + vy * dn + 0.5 * ay * dn * dn }
      : { x: p0.x + ((p0.x - p1.x) / dt1) * dn, y: p0.y + ((p0.y - p1.y) / dt1) * dn };
  } else {
    const r0 = Math.hypot(p0.x - h0.x, p0.y - h0.y);
    const r1 = Math.hypot(p1.x - h1.x, p1.y - h1.y);
    const thN = useAccel ? th0 + omega * dn + 0.5 * alpha * dn * dn : th0 + (wrap(th0 - th1) / dt1) * dn;
    const rN = Math.max(0, r0 + ((r0 - r1) / dt1) * dn);
    const hN = { x: h0.x + ((h0.x - h1.x) / dt1) * dn, y: h0.y + ((h0.y - h1.y) / dt1) * dn };
    next = { x: hN.x + Math.cos(thN) * rN, y: hN.y + Math.sin(thN) * rN };
  }
  return { vx, vy, ax, ay, omega, alpha, next };
}
