import type { FrameData, Phases } from '../../types';
import { clubPt, dist, handsCenter, hipCenter, shoulderCenter } from '../landmarks';
import { movingAverage } from '../tracking/filters';

export interface PhaseOptions {
  W: number;
  H: number;
  /** 桿頭資料可信時用於修正擊球格 */
  useClub: boolean;
}

/** 以雙手速度與高度自動切分揮桿階段 */
export function detectPhases(fd: FrameData, opt: PhaseOptions): Phases | null {
  const { n, t } = fd;
  if (n < 10) return null;
  const { W, H } = opt;
  const fps = (n - 1) / Math.max(t[n - 1] - t[0], 1e-6);
  const r = Math.max(1, Math.round(fps * 0.02));

  const hands = Array.from({ length: n }, (_, f) => handsCenter(fd, f, W, H));
  const bodyLens: number[] = [];
  for (let f = 0; f < n; f += Math.max(1, Math.floor(n / 50))) {
    bodyLens.push(dist(shoulderCenter(fd, f, W, H), hipCenter(fd, f, W, H)));
  }
  bodyLens.sort((a, b) => a - b);
  const body = bodyLens[Math.floor(bodyLens.length / 2)] || H * 0.3;

  const speedRaw = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    const a = Math.max(0, f - 1);
    const b = Math.min(n - 1, f + 1);
    speedRaw[f] = dist(hands[a], hands[b]) / Math.max(t[b] - t[a], 1e-6);
  }
  const speed = movingAverage(speedRaw, r);
  const hy = movingAverage(
    hands.map((h) => h.y),
    r,
  );

  let iMax = 0;
  for (let f = 1; f < n; f++) if (speed[f] > speed[iMax]) iMax = f;
  const thrLow = speed[iMax] * 0.08;
  const thrStill = speed[iMax] * 0.04;

  // 頂點：最大速度前 1.5 秒內雙手最高點
  const winStart = firstIndexAfter(t, t[iMax] - 1.5);
  let top = winStart;
  for (let f = winStart; f <= iMax; f++) if (hy[f] < hy[top]) top = f;

  // 準備姿勢：從上桿最快的格往前找最後一個靜止格（頂點本身速度也接近 0，不可從頂點開始找）
  let iBack = top;
  for (let f = firstIndexAfter(t, t[top] - 2.5); f < top; f++) if (speed[f] > speed[iBack]) iBack = f;
  let address = 0;
  for (let f = iBack; f >= 0; f--) {
    if (speed[f] < thrStill) {
      address = f;
      break;
    }
  }
  // 起桿：雙手離開準備位置超過軀幹長 5%
  let takeaway = address;
  for (let f = address; f <= top; f++) {
    if (dist(hands[f], hands[address]) > body * 0.05) {
      takeaway = f;
      break;
    }
  }

  // 擊球：頂點後雙手回到準備高度
  let impact = -1;
  const impactLimit = firstIndexAfter(t, t[top] + 1.0);
  for (let f = top + 1; f <= Math.min(n - 1, impactLimit); f++) {
    if (hy[f] >= hy[address] - body * 0.03) {
      impact = f;
      break;
    }
  }
  if (impact < 0) {
    impact = top + 1;
    for (let f = top + 1; f <= Math.min(n - 1, impactLimit); f++) if (hy[f] > hy[impact]) impact = f;
  }
  impact = Math.min(impact, n - 1);

  if (opt.useClub) {
    const clubAddr = clubPt(fd, address, W, H);
    if (clubAddr) {
      const w = Math.max(1, Math.round(fps * 0.06));
      let best = impact;
      let bestD = Infinity;
      for (let f = Math.max(top + 1, impact - w); f <= Math.min(n - 1, impact + w); f++) {
        const c = clubPt(fd, f, W, H);
        if (!c) continue;
        const d = dist(c, clubAddr);
        if (d < bestD) {
          bestD = d;
          best = f;
        }
      }
      impact = best;
    }
  }

  // 收桿：擊球後持續 0.15 秒低速
  let finish = n - 1;
  const hold = Math.max(2, Math.round(fps * 0.15));
  for (let f = impact + 1; f < n - hold; f++) {
    let still = true;
    for (let j = f; j < f + hold; j++) {
      if (speed[j] >= thrLow * 1.5) {
        still = false;
        break;
      }
    }
    if (still) {
      finish = f;
      break;
    }
  }

  return { address, takeaway: Math.max(takeaway, address), top, impact: Math.max(impact, top), finish: Math.max(finish, impact) };
}

function firstIndexAfter(t: Float64Array, time: number): number {
  let lo = 0;
  let hi = t.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (t[m] < time) lo = m + 1;
    else hi = m;
  }
  return lo;
}
