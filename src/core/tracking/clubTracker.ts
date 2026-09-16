import { ClubSource, type FrameData, type Handedness } from '../../types';
import { dist, handsCenter, lm, mid, sides, type Pt } from '../landmarks';
import { Kalman1D, zeroPhaseOneEuro } from './filters';

export interface ClubTrackOptions {
  W: number;
  H: number;
  handedness: Handedness;
  /** 手到桿頭的預估距離（像素），無偵測資料時使用 */
  fallbackLengthPx: number;
  minConf?: number;
  /** 超過此秒數的缺口不做插值，改用手部延伸估算 */
  maxGapSec?: number;
}

export interface ClubTrackResult {
  club: Float32Array;
  clubSource: Uint8Array;
  lengthPx: number;
  coverage: number;
}

/**
 * 多層桿頭追蹤：
 * 1. 手部錨點環帶過濾（距雙手 0.35L ~ 1.5L）
 * 2. 卡爾曼濾波剔除離群值
 * 3. 以雙手為圓心的極座標插值補缺口
 * 4. 長缺口以手部方向延伸估算
 * 5. 零相位平滑
 */
export function trackClub(fd: FrameData, opt: ClubTrackOptions): ClubTrackResult {
  const { W, H, n } = { ...opt, n: fd.n };
  const minConf = opt.minConf ?? 0.35;
  const maxGapSec = opt.maxGapSec ?? 0.12;
  const s = sides(opt.handedness);

  const hands: Pt[] = new Array(n);
  for (let f = 0; f < n; f++) hands[f] = handsCenter(fd, f, W, H);

  const raw = (f: number): Pt => ({ x: fd.clubRaw[f * 3] * W, y: fd.clubRaw[f * 3 + 1] * H });
  const isManual = (f: number) => fd.clubRawSource[f] === ClubSource.Manual;
  const isModel = (f: number) =>
    fd.clubRawSource[f] === ClubSource.Model && fd.clubRaw[f * 3 + 2] >= minConf && !Number.isNaN(fd.clubRaw[f * 3]);

  // --- 估算手到桿頭距離 L ---
  const ds: number[] = [];
  for (let f = 0; f < n; f++) {
    if (isManual(f) || (isModel(f) && fd.clubRaw[f * 3 + 2] >= 0.6)) ds.push(dist(raw(f), hands[f]));
  }
  let L = opt.fallbackLengthPx;
  if (ds.length >= 5) {
    ds.sort((a, b) => a - b);
    // 取較高分位：桿身與畫面平行時距離最長，最接近真實桿長
    L = ds[Math.floor(ds.length * 0.75)];
  }

  // --- 1 + 2：環帶 + 卡爾曼過濾 ---
  const accepted = new Uint8Array(n);
  const kx = new Kalman1D((2000 * L) ** 2, (0.03 * L) ** 2);
  const ky = new Kalman1D((2000 * L) ** 2, (0.03 * L) ** 2);
  let lastT = -1;
  let rejectStreak = 0;
  for (let f = 0; f < n; f++) {
    const t = fd.t[f];
    if (kx.initialized && lastT >= 0) {
      const dt = t - lastT;
      if (dt > maxGapSec * 2) {
        kx.initialized = ky.initialized = false;
      } else {
        kx.predict(dt);
        ky.predict(dt);
      }
    }
    lastT = t;
    if (isManual(f)) {
      const p = raw(f);
      if (!kx.initialized) {
        kx.init(p.x);
        ky.init(p.y);
      } else {
        kx.update(p.x, 0.25);
        ky.update(p.y, 0.25);
      }
      accepted[f] = 1;
      rejectStreak = 0;
      continue;
    }
    if (!isModel(f)) continue;
    const p = raw(f);
    const d = dist(p, hands[f]);
    if (d < 0.35 * L || d > 1.5 * L) continue;
    const conf = fd.clubRaw[f * 3 + 2];
    const rScale = 1 / Math.max(conf, 0.1);
    if (!kx.initialized) {
      kx.init(p.x);
      ky.init(p.y);
      accepted[f] = 1;
      continue;
    }
    const m = kx.mahalanobis(p.x, rScale) + ky.mahalanobis(p.y, rScale);
    if (m < 30 || (rejectStreak >= 3 && conf >= 0.6)) {
      if (m >= 30) {
        kx.init(p.x);
        ky.init(p.y);
      } else {
        kx.update(p.x, rScale);
        ky.update(p.y, rScale);
      }
      accepted[f] = 1;
      rejectStreak = 0;
    } else {
      rejectStreak++;
    }
  }

  // --- 3：極座標插值 ---
  const ang = new Float64Array(n).fill(NaN);
  const rad = new Float64Array(n).fill(NaN);
  const src = new Uint8Array(n).fill(ClubSource.None);
  for (let f = 0; f < n; f++) {
    if (!accepted[f]) continue;
    const p = raw(f);
    ang[f] = Math.atan2(p.y - hands[f].y, p.x - hands[f].x);
    rad[f] = dist(p, hands[f]);
    src[f] = isManual(f) ? ClubSource.Manual : ClubSource.Model;
  }
  // 角度連續化（unwrap）
  let prevA = NaN;
  for (let f = 0; f < n; f++) {
    if (Number.isNaN(ang[f])) continue;
    if (!Number.isNaN(prevA)) {
      while (ang[f] - prevA > Math.PI) ang[f] -= 2 * Math.PI;
      while (ang[f] - prevA < -Math.PI) ang[f] += 2 * Math.PI;
    }
    prevA = ang[f];
  }
  let prev = -1;
  for (let f = 0; f < n; f++) {
    if (Number.isNaN(ang[f])) continue;
    if (prev >= 0 && f - prev > 1 && fd.t[f] - fd.t[prev] <= maxGapSec) {
      for (let j = prev + 1; j < f; j++) {
        const r = (fd.t[j] - fd.t[prev]) / (fd.t[f] - fd.t[prev]);
        ang[j] = ang[prev] + r * (ang[f] - ang[prev]);
        rad[j] = rad[prev] + r * (rad[f] - rad[prev]);
        src[j] = ClubSource.Predicted;
      }
    }
    prev = f;
  }

  // --- 4：手部方向延伸估算 ---
  for (let f = 0; f < n; f++) {
    if (src[f] !== ClubSource.None) continue;
    const wrist = lm(fd, f, s.leadWrist, W, H);
    const knuckle = mid(lm(fd, f, s.leadIndex, W, H), lm(fd, f, s.leadPinky, W, H));
    const a = Math.atan2(knuckle.y - wrist.y, knuckle.x - wrist.x);
    if (Number.isNaN(a)) continue;
    let aa = a;
    // 與最近的有效角度保持連續
    const ref = nearestValid(ang, f);
    if (!Number.isNaN(ref)) {
      while (aa - ref > Math.PI) aa -= 2 * Math.PI;
      while (aa - ref < -Math.PI) aa += 2 * Math.PI;
    }
    ang[f] = aa;
    rad[f] = L * 0.9;
    src[f] = ClubSource.HandEstimate;
  }

  // --- 5：平滑（只對非手動點平滑，手動點保持原值） ---
  const angS = zeroPhaseOneEuro(fillNaN(ang), fd.t, 3, 0.05);
  const radS = zeroPhaseOneEuro(fillNaN(rad), fd.t, 2, 0.01);
  const club = new Float32Array(n * 2).fill(NaN);
  let covered = 0;
  for (let f = 0; f < n; f++) {
    if (src[f] === ClubSource.None) continue;
    if (src[f] === ClubSource.Model || src[f] === ClubSource.Manual || src[f] === ClubSource.Predicted) covered++;
    const useRaw = src[f] === ClubSource.Manual;
    const a = useRaw ? ang[f] : angS[f];
    const r = useRaw ? rad[f] : radS[f];
    club[f * 2] = (hands[f].x + Math.cos(a) * r) / W;
    club[f * 2 + 1] = (hands[f].y + Math.sin(a) * r) / H;
  }
  return { club, clubSource: src, lengthPx: L, coverage: n ? covered / n : 0 };
}

function nearestValid(v: Float64Array, i: number): number {
  for (let d = 1; d < v.length; d++) {
    if (i - d >= 0 && !Number.isNaN(v[i - d])) return v[i - d];
    if (i + d < v.length && !Number.isNaN(v[i + d])) return v[i + d];
  }
  return NaN;
}

function fillNaN(v: Float64Array): Float64Array {
  const out = Float64Array.from(v);
  for (let i = 0; i < out.length; i++) if (Number.isNaN(out[i])) out[i] = nearestValid(v, i);
  return out;
}
