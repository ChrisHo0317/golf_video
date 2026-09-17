import { CAND_FROM_MODEL, CAND_OUT_OF_FRAME, CLUB_CANDS, ClubSource, type FrameData, type Handedness } from '../../types';
import { LM, dist, handsCenter, lm, mid, shoulderCenter, sides, vis, type Pt } from '../landmarks';
import { gaussianSmooth, rtsSmoothCA } from './filters';

export interface ClubTrackOptions {
  W: number;
  H: number;
  handedness: Handedness;
  /** 手到桿頭的預估距離（像素），無偵測資料時使用 */
  fallbackLengthPx: number;
  minConf?: number;
  /** 超過此秒數的缺口視為無資料（改以手部方向估算） */
  interpGapSec?: number;
}

export interface ClubTrackResult {
  club: Float32Array;
  clubSource: Uint8Array;
  lengthPx: number;
  coverage: number;
}

interface Cand {
  /** 桿身相對手臂的角度（手腕屈伸角），弧度 */
  psi: number;
  theta: number;
  r: number;
  conf: number;
  oof: boolean;
  src: number;
}

interface RawCand {
  x: number;
  y: number;
  conf: number;
  flags: number;
  src: number;
}

const DEG = Math.PI / 180;
/** 角度量測雜訊（信心值 1 時） */
const SIGMA_MEAS = 4 * DEG;
/** 手腕角加加速度的過程雜訊強度 (rad/s³)² */
const Q_PSI = (1500 * DEG * 30) ** 2;
/** 桿身絕對角度的過程雜訊強度：甩桿時角速度變化比手腕角更劇烈 */
const Q_THETA = (6000 * DEG * 30) ** 2;
/** 輸出軌跡的平滑強度（秒）：高速段保留真實動作，慢速段（準備、頂點、收桿）加強平滑 */
const SMOOTH_ANGLE_FAST = 0.03;
const SMOOTH_ANGLE_SLOW = 0.12;
const SMOOTH_LEN_FAST = 0.06;
const SMOOTH_LEN_SLOW = 0.15;
/** 桿長比例的過程雜訊強度 */
const Q_LEN = 400;

const wrap = (d: number) => {
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
};

const huber = (u: number) => {
  const a = Math.abs(u);
  return a <= 1 ? a * a : 2 * a - 1;
};

/**
 * 桿頭追蹤（前後慣性分析）：
 * 1. 每格收集多個候選（模型偵測、影像桿身偵測、手動標記）
 * 2. 以「桿身相對手臂的角度」為狀態，用動態規劃從整段影片挑出最連續的一條路徑（可略過不可靠的格）
 * 3. 等加速度模型的前向卡爾曼 + 反向 RTS 平滑，缺漏格依前後的角速度與角加速度推估；
 *    平滑後殘差過大的量測剔除後重算
 * 4. 完全沒有資料的區段，以手部方向估算
 */
export function trackClub(fd: FrameData, opt: ClubTrackOptions): ClubTrackResult {
  const { W, H } = opt;
  const n = fd.n;
  const t = fd.t;
  const minConf = opt.minConf ?? 0.15;
  const interpGapSec = opt.interpGapSec ?? 0.45;
  const s = sides(opt.handedness);
  const fps = n > 1 ? (n - 1) / Math.max(t[n - 1] - t[0], 1e-6) : 30;
  /** 以 30fps 為基準的每格權重，讓不同格率的成本一致 */
  const w = 30 / fps;

  const hands: Pt[] = new Array(n);
  for (let f = 0; f < n; f++) hands[f] = handsCenter(fd, f, W, H);

  // ---- 手臂角（肩中心→雙手）；雙手太靠近肩膀時角度不穩，改用內插 ----
  const torso: number[] = [];
  for (let f = 0; f < n; f++) {
    torso.push(dist(shoulderCenter(fd, f, W, H), mid(lm(fd, f, LM.leftHip, W, H), lm(fd, f, LM.rightHip, W, H))));
  }
  const torsoMed = [...torso].filter(Number.isFinite).sort((a, b) => a - b)[Math.floor(n / 2)] || H * 0.3;
  const arm = new Float64Array(n).fill(NaN);
  for (let f = 0; f < n; f++) {
    const sc = shoulderCenter(fd, f, W, H);
    if (dist(sc, hands[f]) > 0.3 * torsoMed) arm[f] = Math.atan2(hands[f].y - sc.y, hands[f].x - sc.x);
  }
  unwrapInterp(arm, t);

  // ---- 手部移動速度：高速時影像模糊，影像桿身偵測的信心值打折 ----
  const handSpeed = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    const a = Math.max(0, f - 1);
    const b = Math.min(n - 1, f + 1);
    handSpeed[f] = dist(hands[a], hands[b]) / Math.max(t[b] - t[a], 1e-6);
  }
  let maxHandSpeed = 1e-6;
  for (const v of handSpeed) if (Number.isFinite(v) && v > maxHandSpeed) maxHandSpeed = v;

  // ---- 雙手的「準備位置」（整段影片的中位數）；手離開這裡時，靜態背景線不可能是桿身 ----
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const handsHome = { x: med(hands.map((h) => h.x)), y: med(hands.map((h) => h.y)) };
  const stride = fd.clubCands ? Math.round(fd.clubCands.length / Math.max(1, n * CLUB_CANDS)) : 0;

  // ---- 收集候選 ----
  const rawCands: RawCand[][] = [];
  for (let f = 0; f < n; f++) {
    const list: RawCand[] = [];
    if (fd.clubRawSource[f] === ClubSource.Manual) {
      list.push({ x: fd.clubRaw[f * 3] * W, y: fd.clubRaw[f * 3 + 1] * H, conf: 1, flags: 0, src: ClubSource.Manual });
    } else if (fd.clubCands) {
      const awayFromHome = dist(hands[f], handsHome) > 0.3 * torsoMed;
      for (let k = 0; k < CLUB_CANDS; k++) {
        const o = (f * CLUB_CANDS + k) * stride;
        const x = fd.clubCands[o];
        if (Number.isNaN(x)) continue;
        const flags = fd.clubCands[o + 3];
        const src = flags & CAND_FROM_MODEL ? ClubSource.Model : ClubSource.Shaft;
        let conf = fd.clubCands[o + 2];
        const bgRatio = stride >= 5 ? fd.clubCands[o + 4] : 0;
        if (src === ClubSource.Shaft && awayFromHome && bgRatio > 0.4) conf *= 0.25;
        list.push({ x: x * W, y: fd.clubCands[o + 1] * H, conf, flags, src });
      }
    } else if (!Number.isNaN(fd.clubRaw[f * 3]) && fd.clubRawSource[f] !== ClubSource.None) {
      const src = fd.clubRawSource[f] === ClubSource.Model ? ClubSource.Model : ClubSource.Shaft;
      list.push({ x: fd.clubRaw[f * 3] * W, y: fd.clubRaw[f * 3 + 1] * H, conf: fd.clubRaw[f * 3 + 2], flags: 0, src });
    }
    for (const c of list) {
      // 清晰的桿身（高信心）不打折：轉換期桿身幾乎靜止，手卻移動很快
      if (c.src === ClubSource.Shaft && c.conf < 0.8 && handSpeed[f] / maxHandSpeed > 0.35) c.conf *= 0.6;
    }
    rawCands.push(list);
  }

  // ---- 手到桿頭距離 L ----
  const ds: number[] = [];
  for (let f = 0; f < n; f++) {
    const c = rawCands[f][0];
    if (c && !(c.flags & CAND_OUT_OF_FRAME) && (c.src === ClubSource.Manual || c.conf >= 0.5)) ds.push(dist(c, hands[f]));
  }
  let L = opt.fallbackLengthPx;
  if (ds.length >= 5) {
    ds.sort((a, b) => a - b);
    // 取較高分位：桿身與畫面平行時距離最長，最接近真實桿長
    L = ds[Math.floor(ds.length * 0.75)];
  }

  const cands: Cand[][] = rawCands.map((list, f) => {
    const out: Cand[] = [];
    for (const c of list) {
      const manual = c.src === ClubSource.Manual;
      if (!manual && c.conf < minConf) continue;
      const r = dist(c, hands[f]);
      const oof = (c.flags & CAND_OUT_OF_FRAME) !== 0;
      if (!manual && !oof && (r < 0.35 * L || r > 1.5 * L)) continue;
      const theta = Math.atan2(c.y - hands[f].y, c.x - hands[f].x);
      out.push({ psi: wrap(theta - arm[f]), theta, r, conf: c.conf, oof, src: c.src });
    }
    return out;
  });

  // ---- 動態規劃：挑選最連續的候選路徑 ----
  const speedNorm = Float64Array.from(handSpeed, (v) => (Number.isFinite(v) ? v / maxHandSpeed : 0));
  const selected = selectPath(cands, arm, speedNorm, t, fps, w);

  // ---- 量測序列（角度沿路徑連續化） ----
  const zPsi = new Float64Array(n).fill(NaN);
  const rPsi = new Float64Array(n).fill(NaN);
  const zTheta = new Float64Array(n).fill(NaN);
  const zLen = new Float64Array(n).fill(NaN);
  const rLen = new Float64Array(n).fill(NaN);
  const measSrc = new Uint8Array(n).fill(ClubSource.None);
  const selConf = new Float64Array(n);
  let prevPsi = NaN;
  let prevTheta = NaN;
  let prevF = -1;
  for (let f = 0; f < n; f++) {
    const k = selected[f];
    if (k < 0) continue;
    const c = cands[f][k];
    const psi = Number.isNaN(prevPsi) ? c.psi : prevPsi + wrap(c.psi - prevPsi);
    prevPsi = psi;
    // 絕對角度連續化：轉動超過 120° 時，方向依手臂旋轉方向決定
    let dTh = Number.isNaN(prevTheta) ? 0 : wrap(c.theta - prevTheta);
    if (prevF >= 0 && Math.abs(dTh) > 120 * DEG) {
      const dArm = arm[f] - arm[prevF];
      if (Math.abs(dArm) > 5 * DEG && Math.sign(dTh) !== Math.sign(dArm)) dTh += dTh > 0 ? -2 * Math.PI : 2 * Math.PI;
    }
    const theta = Number.isNaN(prevTheta) ? c.theta : prevTheta + dTh;
    prevTheta = theta;
    prevF = f;
    zTheta[f] = theta;
    const manual = c.src === ClubSource.Manual;
    zPsi[f] = psi;
    rPsi[f] = manual ? (1 * DEG) ** 2 : (SIGMA_MEAS / Math.max(c.conf, 0.05)) ** 2;
    measSrc[f] = c.src;
    selConf[f] = c.conf;
    if (!c.oof) {
      zLen[f] = c.r / L;
      rLen[f] = manual ? 0.0004 : (0.05 / Math.max(c.conf, 0.05)) ** 2;
    }
  }

  if (!measSrc.some((v) => v !== ClubSource.None)) return handEstimateOnly(fd, opt, hands, L, s);

  // ---- 前後慣性平滑 + 殘差剔除 ----
  // 兩個模型：手腕角（桿身跟著手臂轉）與絕對角度（桿身滯後、甩出）；殘差取兩者較小者
  let sm = rtsSmoothCA(zPsi, rPsi, t, Q_PSI);
  let thSm = rtsSmoothCA(zTheta, rPsi, t, Q_THETA);
  const residual = (f: number) => {
    const rp = Math.abs(zPsi[f] - sm.x[f]) / Math.sqrt(sm.varX[f] + rPsi[f]);
    const rt = Math.abs(zTheta[f] - thSm.x[f]) / Math.sqrt(thSm.varX[f] + rPsi[f]);
    const ap = Math.abs(zPsi[f] - sm.x[f]);
    const at = Math.abs(zTheta[f] - thSm.x[f]);
    return rp <= rt ? { z: rp, abs: ap, psiBetter: true } : { z: rt, abs: at, psiBetter: false };
  };
  for (let pass = 0; pass < 2; pass++) {
    let removed = 0;
    for (let f = 0; f < n; f++) {
      if (Number.isNaN(zPsi[f]) || measSrc[f] === ClubSource.Manual) continue;
      // 非常清晰的偵測已通過路徑連續性檢查，不因慣性模型跟不上而剔除
      if (selConf[f] >= 0.9) continue;
      const r = residual(f);
      if (r.z > 3 && r.abs > 15 * DEG) {
        zPsi[f] = NaN;
        zTheta[f] = NaN;
        zLen[f] = NaN;
        measSrc[f] = ClubSource.None;
        removed++;
      }
    }
    if (!removed) break;
    sm = rtsSmoothCA(zPsi, rPsi, t, Q_PSI);
    thSm = rtsSmoothCA(zTheta, rPsi, t, Q_THETA);
  }
  const lenSm = rtsSmoothCA(zLen, rLen, t, Q_LEN);

  // ---- 組合輸出 ----
  const club = new Float32Array(n * 2).fill(NaN);
  const src = new Uint8Array(n).fill(ClubSource.None);
  const prevMeas = new Int32Array(n).fill(-1);
  const nextMeas = new Int32Array(n).fill(-1);
  for (let f = 0, last = -1; f < n; f++) {
    if (measSrc[f] !== ClubSource.None) last = f;
    prevMeas[f] = last;
  }
  for (let f = n - 1, next = -1; f >= 0; f--) {
    if (measSrc[f] !== ClubSource.None) next = f;
    nextMeas[f] = next;
  }
  // 先決定每格的角度與長度，再整體平滑，避免在不同模型間切換造成的鋸齒
  const thetaF = new Float64Array(n);
  const rF = new Float64Array(n);
  const pin = new Float64Array(n).fill(1);
  // 最近的人工標記：人工標記夾住的短缺口，以標記內插為準（忽略期間的自動偵測）
  const prevManual = new Int32Array(n).fill(-1);
  const nextManual = new Int32Array(n).fill(-1);
  for (let f = 0, last = -1; f < n; f++) {
    if (measSrc[f] === ClubSource.Manual) last = f;
    prevManual[f] = last;
  }
  for (let f = n - 1, next = -1; f >= 0; f--) {
    if (measSrc[f] === ClubSource.Manual) next = f;
    nextManual[f] = next;
  }
  let covered = 0;
  for (let f = 0; f < n; f++) {
    let prev = prevMeas[f];
    let next = nextMeas[f];
    let label: number;
    const betweenManual =
      measSrc[f] !== ClubSource.Manual && prevManual[f] >= 0 && nextManual[f] >= 0 && t[nextManual[f]] - t[prevManual[f]] <= interpGapSec;
    if (betweenManual) {
      prev = prevManual[f];
      next = nextManual[f];
      label = ClubSource.Predicted;
    } else if (measSrc[f] !== ClubSource.None) label = measSrc[f];
    else if (prev >= 0 && next >= 0 && t[next] - t[prev] <= interpGapSec) label = ClubSource.Predicted;
    else label = ClubSource.HandEstimate;

    const lenRatio = Number.isFinite(lenSm.x[f]) ? lenSm.x[f] : 0.95;
    let r = Math.min(1.5, Math.max(0.35, lenRatio)) * L;
    let theta = arm[f] + sm.x[f];
    if (label !== ClubSource.Predicted && label !== ClubSource.HandEstimate) {
      // 有量測的格：採用擬合較好的模型；兩個模型都跟不上時直接用量測值
      const res = residual(f);
      if (res.abs > 10 * DEG) theta = zTheta[f];
      else if (!res.psiBetter) theta = thSm.x[f];
    } else if (label === ClubSource.Predicted && measSrc[prev] === ClubSource.Manual && measSrc[next] === ClubSource.Manual) {
      // 前後都是人工標記：在兩個實際位置之間依時間線性內插角度與長度，避免慣性模型過衝
      const u = (t[f] - t[prev]) / Math.max(t[next] - t[prev], 1e-6);
      theta = zTheta[prev] + (zTheta[next] - zTheta[prev]) * u;
      const rp = zLen[prev] * L;
      const rn = zLen[next] * L;
      if (Number.isFinite(rp) && Number.isFinite(rn)) r = rp + (rn - rp) * u;
    } else if (label === ClubSource.Predicted && Math.abs(zPsi[next] - zPsi[prev]) > 30 * DEG) {
      // 缺口前後手腕角變化大：桿身不是跟著手臂轉，改用絕對角度的慣性推估
      theta = thSm.x[f];
    } else if (label === ClubSource.HandEstimate) {
      // 靠近有資料的區段時沿用慣性推估，遠離時改用手部方向
      const nearest = Math.min(prev >= 0 ? t[f] - t[prev] : Infinity, next >= 0 ? t[next] - t[f] : Infinity);
      const est = handDirection(fd, f, W, H, s);
      if (nearest > interpGapSec / 2 && Number.isFinite(est)) theta = est;
    }
    if (label === ClubSource.Manual) {
      const mx = fd.clubRaw[f * 3] * W;
      const my = fd.clubRaw[f * 3 + 1] * H;
      theta = Math.atan2(my - hands[f].y, mx - hands[f].x);
      r = Math.hypot(mx - hands[f].x, my - hands[f].y);
      pin[f] = 1e6;
    }
    // 角度連續化
    thetaF[f] = f > 0 ? thetaF[f - 1] + wrap(theta - thetaF[f - 1]) : theta;
    rF[f] = r;
    if (label !== ClubSource.HandEstimate) covered++;
    src[f] = label;
  }

  // 自適應高斯平滑：依雙手速度（前後各取鄰近最大值，避免在加速起點過度平滑）決定強度
  const sigA = new Float64Array(n);
  const sigL = new Float64Array(n);
  const reachFrames = Math.max(1, Math.round(fps * 0.05));
  // 桿身角速度（每秒 600° 視為高速）
  const angFast = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    const a = Math.max(0, f - 1);
    const b = Math.min(n - 1, f + 1);
    angFast[f] = Math.abs(thetaF[b] - thetaF[a]) / Math.max(t[b] - t[a], 1e-6) / (600 * DEG);
  }
  for (let f = 0; f < n; f++) {
    let sp = 0;
    for (let j = Math.max(0, f - reachFrames); j <= Math.min(n - 1, f + reachFrames); j++) sp = Math.max(sp, speedNorm[j], angFast[j]);
    const slow = Math.max(0, Math.min(1, (0.5 - sp) / 0.4));
    sigA[f] = SMOOTH_ANGLE_FAST + (SMOOTH_ANGLE_SLOW - SMOOTH_ANGLE_FAST) * slow;
    sigL[f] = SMOOTH_LEN_FAST + (SMOOTH_LEN_SLOW - SMOOTH_LEN_FAST) * slow;
  }
  const thetaS = gaussianSmooth(thetaF, t, sigA, pin);
  const rS = gaussianSmooth(rF, t, sigL, pin);
  for (let f = 0; f < n; f++) {
    if (src[f] === ClubSource.Manual) {
      // 人工標記是實際位置，不做平滑
      club[f * 2] = fd.clubRaw[f * 3];
      club[f * 2 + 1] = fd.clubRaw[f * 3 + 1];
      continue;
    }
    club[f * 2] = (hands[f].x + Math.cos(thetaS[f]) * rS[f]) / W;
    club[f * 2 + 1] = (hands[f].y + Math.sin(thetaS[f]) * rS[f]) / H;
  }
  return { club, clubSource: src, lengthPx: L, coverage: n ? covered / n : 0 };
}

/**
 * 動態規劃（Viterbi，可跳格）：
 * 成本 = 候選信心 + 手腕角的變化量（依時間差放寬）+ 略過格數 + 重新開始的懲罰
 * 回傳每格選中的候選索引，-1 表示略過
 */
function selectPath(cands: Cand[][], arm: Float64Array, speedNorm: Float64Array, t: Float64Array, fps: number, w: number): Int32Array {
  const n = cands.length;
  const G = Math.max(2, Math.round(fps * 0.2));
  const C_MISS = 1.2 * w;
  const C_RESTART = 6;
  const best: Float64Array[] = cands.map((c) => new Float64Array(c.length).fill(Infinity));
  // 回溯：前一格 = -1 表示由 D（重新開始）接上
  const bpF: Int32Array[] = cands.map((c) => new Int32Array(c.length).fill(-1));
  const bpK: Int32Array[] = cands.map((c) => new Int32Array(c.length).fill(-1));
  // D[f]：處理完 0..f-1 且第 f-1 格未選候選的最小成本；Dsrc 為該路徑最後選中的點
  const D = new Float64Array(n + 1);
  const DsrcF = new Int32Array(n + 1).fill(-1);
  const DsrcK = new Int32Array(n + 1).fill(-1);
  const bestAny = new Float64Array(n).fill(Infinity);
  const bestAnyK = new Int32Array(n).fill(-1);

  // 對數概似比：信心值高於 0.3 為獎勵、低於則為懲罰（相對於略過該格）
  const emission = (c: Cand) => (c.src === ClubSource.Manual ? -50 : -2 * Math.log(Math.max(c.conf, 0.05) / 0.3) * w);
  // 手腕角超過 150° 幾乎不可能
  const prior = (c: Cand) => {
    const over = Math.abs(c.psi) - 150 * DEG;
    return over > 0 ? (over / (30 * DEG)) ** 2 * w : 0;
  };

  for (let f = 0; f < n; f++) {
    const list = cands[f];
    for (let k = 0; k < list.length; k++) {
      const c = list[k];
      let bestCost = D[f] + C_RESTART;
      let pf = -1;
      let pk = -1;
      for (let g = 1; g <= G && f - g >= 0; g++) {
        const pl = cands[f - g];
        const dt = Math.max(t[f] - t[f - g], 1e-4);
        // 擊球前後桿身每秒可轉數千度：雙手越快，容許的角度變化越大
        const fast = Math.max(speedNorm[f], speedNorm[f - g]);
        const sigma = 8 * DEG + (600 + 2400 * fast) * DEG * dt;
        const miss = C_MISS * (g - 1);
        for (let j = 0; j < pl.length; j++) {
          const base = best[f - g][j];
          if (!Number.isFinite(base)) continue;
          const p = pl[j];
          // 桿身絕對角速度上限約 3000°/s
          if (c.src !== ClubSource.Manual && Math.abs(wrap(c.theta - p.theta)) / dt > 3000 * DEG) continue;
          // 兩種合理運動取其一：桿身跟著手臂轉（手腕角不變），或桿身滯後（絕對角度不變）
          const dTheta = wrap(c.theta - p.theta);
          let smooth = Math.min(huber(wrap(c.psi - p.psi) / sigma), huber(dTheta / sigma));
          // 快速轉動時，桿身應與手臂同方向旋轉
          const dArm = arm[f] - arm[f - g];
          // 接近半圈時正負方向無法分辨，兩個方向都可能
          const ambiguous = Math.abs(dTheta) > 150 * DEG;
          if (!ambiguous && Math.abs(dTheta) > 30 * DEG && Math.abs(dArm) > 10 * DEG && Math.sign(dTheta) !== Math.sign(dArm)) smooth += 3;
          const cost = base + miss + smooth * w;
          if (cost < bestCost) {
            bestCost = cost;
            pf = f - g;
            pk = j;
          }
        }
      }
      best[f][k] = bestCost + emission(c) + prior(c);
      bpF[f][k] = pf;
      bpK[f][k] = pk;
      if (best[f][k] < bestAny[f]) {
        bestAny[f] = best[f][k];
        bestAnyK[f] = k;
      }
    }
    // 第 f 格略過
    if (bestAny[f] < D[f]) {
      D[f + 1] = bestAny[f] + C_MISS;
      DsrcF[f + 1] = f;
      DsrcK[f + 1] = bestAnyK[f];
    } else {
      D[f + 1] = D[f] + C_MISS;
      DsrcF[f + 1] = DsrcF[f];
      DsrcK[f + 1] = DsrcK[f];
    }
  }

  const sel = new Int32Array(n).fill(-1);
  let f = -1;
  let k = -1;
  if (n > 0 && bestAny[n - 1] <= D[n]) {
    f = n - 1;
    k = bestAnyK[n - 1];
  } else if (n > 0) {
    f = DsrcF[n];
    k = DsrcK[n];
  }
  while (f >= 0 && k >= 0) {
    sel[f] = k;
    const pf = bpF[f][k];
    const pk = bpK[f][k];
    if (pf >= 0) {
      f = pf;
      k = pk;
    } else {
      const nf = DsrcF[f];
      k = DsrcK[f];
      f = nf;
    }
  }
  return sel;
}

/** 角度序列：缺值以線性內插補齊，並連續化 */
function unwrapInterp(a: Float64Array, t: Float64Array) {
  const n = a.length;
  let prev = -1;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(a[i])) continue;
    if (prev >= 0) {
      while (a[i] - a[prev] > Math.PI) a[i] -= 2 * Math.PI;
      while (a[i] - a[prev] < -Math.PI) a[i] += 2 * Math.PI;
      for (let j = prev + 1; j < i; j++) a[j] = a[prev] + ((t[j] - t[prev]) / (t[i] - t[prev])) * (a[i] - a[prev]);
    } else {
      for (let j = 0; j < i; j++) a[j] = a[i];
    }
    prev = i;
  }
  if (prev < 0) a.fill(0);
  else for (let j = prev + 1; j < n; j++) a[j] = a[prev];
}

/** 以手腕→指節方向估算桿身方向；前導手被遮住時改用後手 */
function handDirection(fd: FrameData, f: number, W: number, H: number, s: ReturnType<typeof sides>): number {
  const useLead = vis(fd, f, s.leadWrist) >= vis(fd, f, s.trailWrist) * 0.5;
  const wrist = lm(fd, f, useLead ? s.leadWrist : s.trailWrist, W, H);
  const knuckle = useLead
    ? mid(lm(fd, f, s.leadIndex, W, H), lm(fd, f, s.leadPinky, W, H))
    : mid(lm(fd, f, s.trailIndex, W, H), lm(fd, f, s.trailPinky, W, H));
  return Math.atan2(knuckle.y - wrist.y, knuckle.x - wrist.x);
}

function handEstimateOnly(fd: FrameData, opt: ClubTrackOptions, hands: Pt[], L: number, s: ReturnType<typeof sides>): ClubTrackResult {
  const { W, H } = opt;
  const n = fd.n;
  const ang = new Float64Array(n).fill(NaN);
  for (let f = 0; f < n; f++) {
    const a = handDirection(fd, f, W, H, s);
    if (Number.isFinite(a)) ang[f] = a;
  }
  unwrapInterp(ang, fd.t);
  const sm = rtsSmoothCA(ang, new Float64Array(n).fill((15 * DEG) ** 2), fd.t, Q_PSI);
  const club = new Float32Array(n * 2).fill(NaN);
  const src = new Uint8Array(n).fill(ClubSource.HandEstimate);
  for (let f = 0; f < n; f++) {
    const a = sm.x[f];
    club[f * 2] = (hands[f].x + Math.cos(a) * L * 0.9) / W;
    club[f * 2 + 1] = (hands[f].y + Math.sin(a) * L * 0.9) / H;
  }
  return { club, clubSource: src, lengthPx: L, coverage: 0 };
}
