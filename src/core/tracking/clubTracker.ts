import { ClubSource, type FrameData, type Handedness } from '../../types';
import { dist, handsCenter, lm, mid, shoulderCenter, sides, vis, type Pt } from '../landmarks';
import { Kalman1D, zeroPhaseOneEuro } from './filters';

export interface ClubTrackOptions {
  W: number;
  H: number;
  handedness: Handedness;
  /** 手到桿頭的預估距離（像素），無偵測資料時使用 */
  fallbackLengthPx: number;
  minConf?: number;
  /** 卡爾曼濾波在缺口超過此秒數時重新初始化 */
  maxGapSec?: number;
  /** 超過此秒數的缺口不做插值，改用手部延伸估算（高速下桿常整段模糊） */
  interpGapSec?: number;
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
  const interpGapSec = opt.interpGapSec ?? 0.45;
  const s = sides(opt.handedness);

  const hands: Pt[] = new Array(n);
  for (let f = 0; f < n; f++) hands[f] = handsCenter(fd, f, W, H);

  const raw = (f: number): Pt => ({ x: fd.clubRaw[f * 3] * W, y: fd.clubRaw[f * 3 + 1] * H });
  const isManual = (f: number) => fd.clubRawSource[f] === ClubSource.Manual;
  // 雙手高速移動時畫面模糊，影像桿身偵測容易抓到背景直線，降低其信心值
  const handSpeed = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    const a = Math.max(0, f - 1);
    const b = Math.min(n - 1, f + 1);
    handSpeed[f] = dist(hands[a], hands[b]) / Math.max(fd.t[b] - fd.t[a], 1e-6);
  }
  const maxHandSpeed = Math.max(...handSpeed.filter(Number.isFinite), 1e-6);
  const confOf = (f: number) => {
    const c = fd.clubRaw[f * 3 + 2];
    if (fd.clubRawSource[f] !== ClubSource.Shaft) return c;
    const blur = handSpeed[f] / maxHandSpeed;
    return blur > 0.35 ? c * 0.6 : c;
  };
  const isModel = (f: number) =>
    (fd.clubRawSource[f] === ClubSource.Model || fd.clubRawSource[f] === ClubSource.Shaft) &&
    confOf(f) >= minConf &&
    !Number.isNaN(fd.clubRaw[f * 3]);

  // --- 估算手到桿頭距離 L ---
  const ds: number[] = [];
  for (let f = 0; f < n; f++) {
    if (isManual(f) || (isModel(f) && confOf(f) >= 0.6)) ds.push(dist(raw(f), hands[f]));
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
    const conf = confOf(f);
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

  // 手臂（肩中心→雙手）的旋轉角：桿身在下桿時與手臂同向旋轉，用來決定內插方向與進度
  const arm = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    const sc = shoulderCenter(fd, f, W, H);
    arm[f] = Math.atan2(hands[f].y - sc.y, hands[f].x - sc.x);
    if (f > 0) {
      while (arm[f] - arm[f - 1] > Math.PI) arm[f] -= 2 * Math.PI;
      while (arm[f] - arm[f - 1] < -Math.PI) arm[f] += 2 * Math.PI;
    }
  }
  // --- 2b：角度一致性（桿身與手臂同向旋轉，且單格轉動量有上限） ---
  const rawAng = (f: number) => {
    const p = raw(f);
    return Math.atan2(p.y - hands[f].y, p.x - hands[f].x);
  };
  const wrap = (d: number) => {
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  };
  const consistent = (a: number, b: number) => {
    const d = wrap(rawAng(b) - rawAng(a));
    const armD = arm[b] - arm[a];
    const dt = Math.max(fd.t[b] - fd.t[a], 1e-3);
    const limit = 3 * Math.abs(armD) + (45 * Math.PI) / 180 + 3 * dt;
    if (Math.abs(d) > limit) return false;
    if (Math.abs(d) > (45 * Math.PI) / 180 && Math.abs(armD) > (5 * Math.PI) / 180 && Math.sign(d) !== Math.sign(armD)) return false;
    return true;
  };
  {
    let last = -1;
    let pending: number[] = [];
    for (let f = 0; f < n; f++) {
      if (!accepted[f]) continue;
      if (last < 0 || isManual(f) || consistent(last, f)) {
        last = f;
        pending = [];
        continue;
      }
      accepted[f] = 0;
      pending.push(f);
      // 連續 3 格彼此一致：視為前一個基準才是錯的，重新接受
      if (pending.length >= 3 && pending.every((g, i) => i === 0 || consistent(pending[i - 1], g))) {
        for (const g of pending) accepted[g] = 1;
        last = pending[pending.length - 1];
        pending = [];
      }
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
    src[f] = fd.clubRawSource[f];
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
  const ARM_MIN = (20 * Math.PI) / 180;
  let prev = -1;
  for (let f = 0; f < n; f++) {
    if (Number.isNaN(ang[f])) continue;
    if (prev >= 0 && f - prev > 1 && fd.t[f] - fd.t[prev] <= interpGapSec) {
      let d = ang[f] - ang[prev];
      const armD = arm[f] - arm[prev];
      const useArm = Math.abs(armD) > ARM_MIN;
      // 角度差接近半圈時，最短路徑可能轉錯邊：改用手臂的旋轉方向
      if (useArm && Math.sign(d) !== Math.sign(armD) && Math.abs(d) > Math.PI / 3) {
        const shift = d > 0 ? -2 * Math.PI : 2 * Math.PI;
        for (let j = f; j < n; j++) if (!Number.isNaN(ang[j])) ang[j] += shift;
        d += shift;
      }
      for (let j = prev + 1; j < f; j++) {
        const rt = (fd.t[j] - fd.t[prev]) / (fd.t[f] - fd.t[prev]);
        const r = useArm ? Math.min(1, Math.max(0, (arm[j] - arm[prev]) / armD)) : rt;
        ang[j] = ang[prev] + r * d;
        rad[j] = rad[prev] + rt * (rad[f] - rad[prev]);
        src[j] = ClubSource.Predicted;
      }
    }
    prev = f;
  }

  // --- 4：手部方向延伸估算 ---
  for (let f = 0; f < n; f++) {
    if (src[f] !== ClubSource.None) continue;
    // 前導手被遮住時改用後手的方向
    const useLead = vis(fd, f, s.leadWrist) >= vis(fd, f, s.trailWrist) * 0.5;
    const wrist = lm(fd, f, useLead ? s.leadWrist : s.trailWrist, W, H);
    const knuckle = useLead
      ? mid(lm(fd, f, s.leadIndex, W, H), lm(fd, f, s.leadPinky, W, H))
      : mid(lm(fd, f, s.trailIndex, W, H), lm(fd, f, s.trailPinky, W, H));
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
  // 角度變化很快（下桿每格可達數十度），用高 beta 降低延遲
  const angS = zeroPhaseOneEuro(fillNaN(ang), fd.t, 3, 1);
  const radS = zeroPhaseOneEuro(fillNaN(rad), fd.t, 2, 0.01);
  const club = new Float32Array(n * 2).fill(NaN);
  let covered = 0;
  for (let f = 0; f < n; f++) {
    if (src[f] === ClubSource.None) continue;
    if (src[f] !== ClubSource.HandEstimate) covered++;
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
