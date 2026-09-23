import { CAND_FROM_MODEL, CAND_HEAD, CAND_OUT_OF_FRAME, CLUB_CANDS, ClubSource, type FrameData, type Handedness } from '../../types';
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
  /** 路徑選擇是否使用慣性外推（預設開啟） */
  useInertia?: boolean;
  /** 是否以前後數格的局部軌跡修正偵測失誤（預設開啟） */
  pathFit?: boolean;
  /** 有慣性歷史時，非慣性運動模型的額外成本 */
  inertiaBias?: number;
}

export interface ClubTrackResult {
  club: Float32Array;
  clubSource: Uint8Array;
  lengthPx: number;
  coverage: number;
}

interface Cand {
  /** 桿頭位置（px） */
  x: number;
  y: number;
  /** 桿身相對手臂的角度（手腕屈伸角），弧度 */
  psi: number;
  theta: number;
  r: number;
  conf: number;
  oof: boolean;
  /** 沿桿身找到了桿頭（長度可信） */
  head: boolean;
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
/** 有慣性歷史時，非慣性運動模型的額外成本 */
const INERTIA_BIAS = 1.5;
/** 輸出軌跡的平滑強度（秒）：高速段保留真實動作，慢速段（準備、頂點、收桿）加強平滑 */
const SMOOTH_ANGLE_FAST = 0.015;
const SMOOTH_ANGLE_SLOW = 0.08;
const SMOOTH_LEN_FAST = 0.02;
const SMOOTH_LEN_SLOW = 0.08;
/** 找到桿頭的格保留自身長度的權重 */
const LEN_ANCHOR = 8;
/** 平滑時間窗內允許的桿頭移動量（相對手到桿頭距離） */
const SMOOTH_MAX_DISP_L = 0.15;
/** 慢速段降低量測自身權重的比例 */
const SLOW_PIN_RELAX = 0.8;
/** 桿長比例的過程雜訊強度 */
const Q_LEN = 400;
/** 前後量測的角度差超過此值時，視為桿頭在畫面上穿過手部附近 */
const BIG_TURN = 100 * DEG;
/** 投影後桿長短於此比例時，視為桿身指向鏡頭 */
const FORESHORTENED_L = 0.7;
/** 上述情況下角度成本的上限 */
const AMBIG_TURN_COST = 1.2;
/** 模型候選（直接認出桿頭）相對影像桿身偵測的優先權，以及開始給優先權的信心門檻 */
const MODEL_BONUS = 1;
const MODEL_TRUST_MIN = 0.3;
/** 局部軌跡預測：前後各取幾格、權重的高斯尺度（格）、判定偵測失誤的容許值 */
const FIT_HALF = 4;
const FIT_SIGMA = 2.5;
const FIT_TOL_L = 0.07;
const FIT_TOL_K = 4;
const FIT_TOL_STEP = 0.8;
/** 局部每格移動量超過此值（相對桿長）就不做修正：轉向太快，曲線描述不了 */
const FIT_MAX_STEP_L = 0.25;
/** 擬合殘差超過此值（相對桿長）代表這段軌跡不符合曲線，預測不可信 */
const FIT_MAX_RMS_L = 0.05;
/** 以預測值取代或補上的量測信心 */
const FIT_CONF = 0.45;
/** 桿頭最大移動速度（手到桿頭距離 / 秒）：擊球瞬間 30fps 下一格可移動超過 1.5 倍桿長 */
const MAX_HEAD_SPEED_L = 72;

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
  // 影像偵測的桿身末端常因對比不足而偏短，因此桿長不低於依身高換算的理論值
  let L = opt.fallbackLengthPx;
  if (ds.length >= 5) {
    ds.sort((a, b) => a - b);
    // 取較高分位：桿身與畫面平行時距離最長，最接近真實桿長
    L = Math.max(L, ds[Math.floor(ds.length * 0.75)]);
  }

  const cands: Cand[][] = rawCands.map((list, f) => {
    const out: Cand[] = [];
    for (const c of list) {
      const manual = c.src === ClubSource.Manual;
      if (!manual && c.conf < minConf) continue;
      const r = dist(c, hands[f]);
      const oof = (c.flags & CAND_OUT_OF_FRAME) !== 0;
      // 影像桿身偵測若量到的長度過短，多半是末端判斷失敗；模型是直接認出桿頭，
      // 桿身指向鏡頭時桿頭本來就會落在雙手附近，只排除明顯不合理的距離
      const minR = c.src === ClubSource.Model ? 0.05 : 0.35;
      if (!manual && !oof && (r < minR * L || r > 1.5 * L)) continue;
      const theta = Math.atan2(c.y - hands[f].y, c.x - hands[f].x);
      const head = manual || c.src === ClubSource.Model || (c.flags & CAND_HEAD) !== 0;
      out.push({ x: c.x, y: c.y, psi: wrap(theta - arm[f]), theta, r, conf: c.conf, oof, head, src: c.src });
    }
    return out;
  });

  // ---- 動態規劃：挑選最連續的候選路徑 ----
  const speedNorm = Float64Array.from(handSpeed, (v) => (Number.isFinite(v) ? v / maxHandSpeed : 0));
  const selected = selectPath(cands, arm, speedNorm, t, fps, w, L, opt.useInertia ?? true, opt.inertiaBias ?? INERTIA_BIAS);

  // ---- 以前後數格的局部軌跡預測，修正單格偵測失誤並補上漏偵測 ----
  const picked = opt.pathFit === false ? cands.map((list, f) => (selected[f] >= 0 ? list[selected[f]] : null)) : localPathFix(cands, selected, hands, arm, t, L);

  // ---- 量測序列（角度沿路徑連續化） ----
  const zPsi = new Float64Array(n).fill(NaN);
  const rPsi = new Float64Array(n).fill(NaN);
  const zTheta = new Float64Array(n).fill(NaN);
  const zLen = new Float64Array(n).fill(NaN);
  const rLen = new Float64Array(n).fill(NaN);
  const measSrc = new Uint8Array(n).fill(ClubSource.None);
  const selConf = new Float64Array(n);
  const selHeadR = new Float64Array(n).fill(NaN);
  const selR = new Float64Array(n).fill(NaN);
  let prevPsi = NaN;
  let prevTheta = NaN;
  let prevF = -1;
  for (let f = 0; f < n; f++) {
    const c = picked[f];
    if (!c) continue;
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
    // 明顯偏短的長度多半是末端判斷失敗，不當作長度量測（人工標記與找到桿頭的除外）
    // 桿頭位置可信（找到桿頭，或貼著畫面邊緣的出界估計）：輸出時直接採用量到的長度
    if (c.head || c.oof) selHeadR[f] = c.r;
    selR[f] = c.r;
    if (manual || c.head || c.oof || c.r >= 0.8 * L) {
      zLen[f] = c.r / L;
      // 出界的長度是估計值，權重較低
      rLen[f] = manual ? 0.0004 : ((c.oof ? 0.12 : 0.05) / Math.max(c.conf, 0.05)) ** 2;
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
  /** 前後最近的有效量測之間角度差很大（桿身指向鏡頭、桿頭在畫面上穿過手部附近）：角度模型不適用 */
  const bigTurnAround = (f: number) => {
    let a = f - 1;
    while (a >= 0 && Number.isNaN(zTheta[a])) a--;
    let b = f + 1;
    while (b < n && Number.isNaN(zTheta[b])) b++;
    return a >= 0 && b < n && Math.abs(zTheta[b] - zTheta[a]) > BIG_TURN;
  };
  for (let pass = 0; pass < 2; pass++) {
    let removed = 0;
    for (let f = 0; f < n; f++) {
      if (Number.isNaN(zPsi[f]) || measSrc[f] === ClubSource.Manual) continue;
      // 非常清晰的偵測已通過路徑連續性檢查，不因慣性模型跟不上而剔除；
      // 模型是直接認出桿頭（不是由桿身推算），門檻放寬
      const trusted = measSrc[f] === ClubSource.Model ? 0.55 : 0.75;
      if (selConf[f] >= trusted || bigTurnAround(f)) continue;
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
  const pinLen = new Float64Array(n).fill(1);
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

    const lenRatio = Number.isFinite(lenSm.x[f]) ? lenSm.x[f] : 1;
    let r = Math.min(1.5, Math.max(0.35, lenRatio)) * L;
    let theta = arm[f] + sm.x[f];
    if (label !== ClubSource.Predicted && label !== ClubSource.HandEstimate) {
      // 有量測的格：清晰的量測直接採用；不清晰時採用擬合較好的模型
      const res = residual(f);
      if (selConf[f] >= 0.6 || res.abs > 10 * DEG) theta = zTheta[f];
      else if (!res.psiBetter) theta = thSm.x[f];
      // 找到桿頭的量測：直接採用量到的長度
      if (Number.isFinite(selHeadR[f]) && selConf[f] >= 0.4) {
        r = selHeadR[f];
        pinLen[f] = 1 + LEN_ANCHOR * selConf[f] * selConf[f];
      }
      pin[f] = 1 + 8 * selConf[f] * selConf[f];
    } else if (label === ClubSource.Predicted && measSrc[prev] === ClubSource.Manual && measSrc[next] === ClubSource.Manual) {
      // 前後都是人工標記：在兩個實際位置之間依時間線性內插角度與長度，避免慣性模型過衝
      const u = (t[f] - t[prev]) / Math.max(t[next] - t[prev], 1e-6);
      theta = zTheta[prev] + (zTheta[next] - zTheta[prev]) * u;
      const rp = zLen[prev] * L;
      const rn = zLen[next] * L;
      if (Number.isFinite(rp) && Number.isFinite(rn)) r = rp + (rn - rp) * u;
    } else if (
      label === ClubSource.Predicted &&
      Math.abs(zTheta[next] - zTheta[prev]) > BIG_TURN &&
      Math.min(selR[prev], selR[next]) < 0.6 * L &&
      t[next] - t[prev] <= 0.15
    ) {
      // 短缺口前後角度差很大、且一端桿身明顯縮短（指向鏡頭）：桿頭在畫面上是從手部附近「穿過」，
      // 以直角座標（相對雙手）內插，避免以角度內插繞一大圈
      const u = (t[f] - t[prev]) / Math.max(t[next] - t[prev], 1e-6);
      const rp = selR[prev];
      const rn = selR[next];
      const vx = Math.cos(zTheta[prev]) * rp * (1 - u) + Math.cos(zTheta[next]) * rn * u;
      const vy = Math.sin(zTheta[prev]) * rp * (1 - u) + Math.sin(zTheta[next]) * rn * u;
      theta = Math.atan2(vy, vx);
      r = Math.max(0.15 * L, Math.hypot(vx, vy));
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
      pinLen[f] = 1e6;
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
  const slowness = new Float64Array(n);
  const reachFrames = Math.max(1, Math.round(fps * 0.05));
  // 桿身角速度（每秒 300° 視為高速）
  const angFast = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    const a = Math.max(0, f - 1);
    const b = Math.min(n - 1, f + 1);
    angFast[f] = Math.abs(thetaF[b] - thetaF[a]) / Math.max(t[b] - t[a], 1e-6) / (300 * DEG);
  }
  for (let f = 0; f < n; f++) {
    let sp = 0;
    for (let j = Math.max(0, f - reachFrames); j <= Math.min(n - 1, f + reachFrames); j++) sp = Math.max(sp, speedNorm[j], angFast[j]);
    const slow = Math.max(0, Math.min(1, (0.5 - sp) / 0.4));
    slowness[f] = slow;
    sigA[f] = SMOOTH_ANGLE_FAST + (SMOOTH_ANGLE_SLOW - SMOOTH_ANGLE_FAST) * slow;
    sigL[f] = SMOOTH_LEN_FAST + (SMOOTH_LEN_SLOW - SMOOTH_LEN_FAST) * slow;
    // 平滑的時間窗內桿頭不該移動太遠，否則像擊球瞬間這種尖峰會被削平。
    // 平滑強度若只用秒設定，120fps 影片等於跨兩格平滑（30fps 時不到半格）。
    const a = Math.max(0, f - 1);
    const b = Math.min(n - 1, f + 1);
    const speed = Math.hypot(Math.cos(thetaF[b]) * rF[b] - Math.cos(thetaF[a]) * rF[a], Math.sin(thetaF[b]) * rF[b] - Math.sin(thetaF[a]) * rF[a]) / Math.max(t[b] - t[a], 1e-6);
    const maxSig = (SMOOTH_MAX_DISP_L * L) / Math.max(speed, 1e-6);
    sigA[f] = Math.min(sigA[f], maxSig);
    sigL[f] = Math.min(sigL[f], maxSig);
  }
  // 慢速段：前後格幾乎相同，量測雜訊靠平滑消除（降低自身權重）；高速段：前後格差異大，以量測為準
  for (let f = 0; f < n; f++) {
    if (src[f] === ClubSource.Manual) continue;
    const k = 1 - SLOW_PIN_RELAX * slowness[f];
    pin[f] = 1 + (pin[f] - 1) * k;
    pinLen[f] = 1 + (pinLen[f] - 1) * k;
  }
  const thetaS = gaussianSmooth(thetaF, t, sigA, pin);
  const rS = gaussianSmooth(rF, t, sigL, pinLen);
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
function selectPath(
  cands: Cand[][],
  arm: Float64Array,
  speedNorm: Float64Array,
  t: Float64Array,
  fps: number,
  w: number,
  L: number,
  useInertia: boolean,
  inertiaBias: number,
): Int32Array {
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
  // 模型是直接認出桿頭，影像桿身偵測是由桿身末端推得（常落在桿頸、偏短），因此模型優先
  const emission = (c: Cand) => {
    if (c.src === ClubSource.Manual) return -50;
    // 模型信心低時不給優先權：低分的模型偵測常常是抓到別的東西
    const trust = Math.min(1, Math.max(0, (c.conf - MODEL_TRUST_MIN) / 0.3));
    const bonus = c.src === ClubSource.Model ? MODEL_BONUS * trust * w : 0;
    return -2 * Math.log(Math.max(c.conf, 0.05) / 0.3) * w - bonus;
  };
  // 手腕角超過 150° 幾乎不可能
  const prior = (c: Cand) => {
    const over = Math.abs(c.psi) - 150 * DEG;
    return over > 0 ? (over / (30 * DEG)) ** 2 * w : 0;
  };

  /** 候選 c（在 f）相對於 p（在 pf、索引 pj）沿路徑的慣性外推成本 */
  const inertiaCost = (c: Cand, p: Cand, pf: number, pj: number, dt: number) => {
    const qf = bpF[pf][pj];
    if (qf < 0) return Infinity;
    const q = cands[qf][bpK[pf][pj]];
    const dt1 = Math.max(t[pf] - t[qf], 1e-4);
    const vx = (p.x - q.x) / dt1;
    const vy = (p.y - q.y) / dt1;
    let ax = 0;
    let ay = 0;
    const rf = bpF[qf][bpK[pf][pj]];
    if (rf >= 0) {
      const r = cands[rf][bpK[qf][bpK[pf][pj]]];
      const dt2 = Math.max(t[qf] - t[rf], 1e-4);
      const span = (dt1 + dt2) / 2;
      ax = (vx - (q.x - r.x) / dt2) / span;
      ay = (vy - (q.y - r.y) / dt2) / span;
    }
    // 後向差分是中點速度，補半格加速度修正
    const px = p.x + (vx + (ax * dt1) / 2) * dt + 0.5 * ax * dt * dt;
    const py = p.y + (vy + (ay * dt1) / 2) * dt + 0.5 * ay * dt * dt;
    // 外推的不確定性隨移動量增加
    const sigmaPos = 0.12 * L + 0.35 * Math.hypot(vx, vy) * dt;
    return huber(Math.hypot(c.x - px, c.y - py) / sigmaPos);
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
          // 桿頭位移上限（每秒約 48 倍手到桿頭距離，約 50 m/s）。不用角速度上限：
          // 擊球前後桿身接近指向鏡頭時，畫面上的角度一格可轉 150° 以上
          if (c.src !== ClubSource.Manual && Math.hypot(c.x - p.x, c.y - p.y) / dt > MAX_HEAD_SPEED_L * L) continue;
          // 兩種合理運動取其一：桿身跟著手臂轉（手腕角不變），或桿身滯後（絕對角度不變）
          const dTheta = wrap(c.theta - p.theta);
          let smooth = Math.min(huber(wrap(c.psi - p.psi) / sigma), huber(dTheta / sigma));
          // 第三種：慣性（沿已選路徑往回取兩點，等加速度外推到這一格）
          if (useInertia) {
            const inertia = inertiaCost(c, p, f - g, j, dt);
            // 已有前段路徑時，優先以慣性解釋；其他運動模型需付出額外成本
            if (Number.isFinite(inertia)) smooth = Math.min(inertia, smooth + inertiaBias);
          }
          // 快速轉動時，桿身應與手臂同方向旋轉
          const dArm = arm[f] - arm[f - g];
          // 接近半圈時正負方向無法分辨，兩個方向都可能
          const ambiguous = Math.abs(dTheta) > 150 * DEG;
          // 桿身指向鏡頭時（投影後的桿長很短），桿頭會在畫面上從手部附近穿過，
          // 角度一格就翻轉近半圈；此時角度不具參考性，成本封頂避免整格被略過
          if (ambiguous && Math.min(c.r, p.r) < FORESHORTENED_L * L) smooth = Math.min(smooth, AMBIG_TURN_COST);
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

/**
 * 以前後各數格的局部軌跡（加權二次擬合，相對雙手的座標）預測每一格的桿頭位置：
 *  - 這一格的偵測偏離預測太多 → 視為誤判，改用預測值（信心調低，後續平滑不會硬鎖在上面）
 *  - 這一格沒有偵測到 → 以預測值補上（需前後都有資料，才不會變成外插）
 * 用途是避免單格辨識失敗或跳到別的物體時，軌跡出現大幅偏移。
 */
function localPathFix(cands: Cand[][], selected: Int32Array, hands: Pt[], arm: Float64Array, t: Float64Array, L: number): (Cand | null)[] {
  const n = cands.length;
  const picked: (Cand | null)[] = new Array(n).fill(null);
  for (let f = 0; f < n; f++) {
    const k = selected[f];
    picked[f] = k >= 0 ? cands[f][k] : null;
  }
  // 相對雙手的座標：扣掉身體與鏡頭的移動後，軌跡才接近平滑的弧線
  const rx = new Float64Array(n).fill(NaN);
  const ry = new Float64Array(n).fill(NaN);
  for (let f = 0; f < n; f++) {
    const c = picked[f];
    if (!c) continue;
    rx[f] = c.x - hands[f].x;
    ry[f] = c.y - hands[f].y;
  }

  const out: (Cand | null)[] = picked.slice();
  for (let f = 0; f < n; f++) {
    const cur = picked[f];
    if (cur?.src === ClubSource.Manual) continue;
    const p = fitAround(rx, ry, picked, t, f);
    if (!p) continue;
    // 高速段（例如下桿）或擬合本身就對不上時，局部曲線不可信，交給原本的慣性模型
    if (p.step > FIT_MAX_STEP_L * L || p.rms > FIT_MAX_RMS_L * L) continue;
    const px = p.x + hands[f].x;
    const py = p.y + hands[f].y;
    const distTo = (c: Cand) => Math.hypot(c.x - px, c.y - py);
    // 容許值隨擬合殘差與這段的移動量放大，避免把正常的快速移動當成失誤
    const tol = Math.max(FIT_TOL_L * L, FIT_TOL_K * p.rms, FIT_TOL_STEP * p.step);
    if (cur && distTo(cur) <= tol) continue;
    // 這一格的選擇可疑（或根本沒選到）：先看同一格有沒有貼近預測軌跡的其他候選，
    // 信心低但位置對的偵測常被信心高卻偏掉的候選壓過
    let alt: Cand | null = null;
    let altD = tol;
    for (const c of cands[f]) {
      const cd = distTo(c);
      if (cd < altD) {
        alt = c;
        altD = cd;
      }
    }
    if (alt) out[f] = alt;
    else if (cur) out[f] = makeCand(px, py, hands[f], arm[f], Math.min(cur.conf, FIT_CONF), cur.src);
    else out[f] = makeCand(px, py, hands[f], arm[f], FIT_CONF, ClubSource.Predicted);
  }
  return out;
}

/** 以 (f−FIT_HALF, f+FIT_HALF) 內的其他格做加權二次擬合，回傳這一格的預測位置與擬合殘差 */
function fitAround(rx: Float64Array, ry: Float64Array, picked: (Cand | null)[], t: Float64Array, f: number) {
  const ts: number[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  const ws: number[] = [];
  let before = 0;
  let after = 0;
  for (let g = Math.max(0, f - FIT_HALF); g <= Math.min(picked.length - 1, f + FIT_HALF); g++) {
    if (g === f || !picked[g] || Number.isNaN(rx[g])) continue;
    const d = g - f;
    ts.push(t[g] - t[f]);
    xs.push(rx[g]);
    ys.push(ry[g]);
    ws.push(Math.max(picked[g]!.conf, 0.1) * Math.exp(-(d * d) / (2 * FIT_SIGMA * FIT_SIGMA)));
    if (d < 0) before++;
    else after++;
  }
  // 前後都要有資料，否則是外插，不可信
  if (!before || !after || ts.length < 3) return null;
  // 這段時間內桿頭每格移動多少：下桿時一格可移動超過一個桿長，
  // 二次曲線描述不了那麼劇烈的轉向，這種區段不做修正
  const steps: number[] = [];
  for (let i = 1; i < ts.length; i++) steps.push(Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]));
  steps.sort((a, b) => a - b);
  const step = steps.length ? steps[steps.length >> 1] : 0;
  const deg = ts.length >= 4 ? 2 : 1;
  const fx = polyFit(ts, xs, ws, deg);
  const fy = polyFit(ts, ys, ws, deg);
  if (!fx || !fy) return null;
  let se = 0;
  let sw = 0;
  for (let i = 0; i < ts.length; i++) {
    const ex = polyAt(fx, ts[i]) - xs[i];
    const ey = polyAt(fy, ts[i]) - ys[i];
    se += ws[i] * (ex * ex + ey * ey);
    sw += ws[i];
  }
  return { x: fx[0], y: fy[0], rms: Math.sqrt(se / Math.max(sw, 1e-6)), step };
}

/** 加權最小平方多項式擬合（次數 1 或 2），以高斯消去法解正規方程 */
function polyFit(ts: number[], vs: number[], ws: number[], deg: number): number[] | null {
  const m = deg + 1;
  const A: number[][] = Array.from({ length: m }, () => new Array(m + 1).fill(0));
  for (let i = 0; i < ts.length; i++) {
    const pw = [1, ts[i], ts[i] * ts[i]];
    for (let r = 0; r < m; r++) {
      for (let c = 0; c < m; c++) A[r][c] += ws[i] * pw[r] * pw[c];
      A[r][m] += ws[i] * pw[r] * vs[i];
    }
  }
  for (let col = 0; col < m; col++) {
    let piv = col;
    for (let r = col + 1; r < m; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-9) return null;
    [A[col], A[piv]] = [A[piv], A[col]];
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const k = A[r][col] / A[col][col];
      for (let c = col; c <= m; c++) A[r][c] -= k * A[col][c];
    }
  }
  return A.map((row, r) => row[m] / row[r]);
}

const polyAt = (c: number[], x: number) => c.reduce((s, v, i) => s + v * x ** i, 0);

/** 由座標組出候選（角度、長度隨之重算） */
function makeCand(x: number, y: number, hand: Pt, armAngle: number, conf: number, src: number): Cand {
  const theta = Math.atan2(y - hand.y, x - hand.x);
  return { x, y, theta, psi: wrap(theta - armAngle), r: Math.hypot(x - hand.x, y - hand.y), conf, oof: false, head: false, src };
}
