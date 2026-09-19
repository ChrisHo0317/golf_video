import { CAND_HEAD, CAND_OUT_OF_FRAME } from '../../types';
import { LM, weightedMid } from '../landmarks';
import type { Background } from '../video/background';

type NLm = { x: number; y: number; visibility?: number }[];

export interface ShaftCandidate {
  /** 桿頭位置（分析畫布像素座標） */
  x: number;
  y: number;
  conf: number;
  angle: number;
  flags: number;
  /** 同一條線在靜態背景中的強度比例（接近 1 表示是背景線） */
  bgRatio: number;
}

const DEG = Math.PI / 180;
const N_ANGLES = 360;
const NMS_DEG = 10;

/**
 * 不需訓練的桿身偵測：
 * 以雙手為圓心，對每個方向沿射線計算「細線」的脊線強度，
 * 取幾個最強的方向作為候選，再沿各方向找桿身末端作為桿頭位置。
 * 哪個候選才是真的桿身，交給追蹤器以整段影片的連續性判斷。
 */
export class ShaftDetector {
  private gray = new Float32Array(0);
  private score = new Float32Array(N_ANGLES);
  private bestOffset = new Float32Array(N_ANGLES);
  /** 桿身完整在畫面內時量到的長度（相對 L），用於桿頭出界時估算 */
  private lenRatios: number[] = [];

  reset() {
    this.lenRatios = [];
  }

  private lenRatio() {
    if (this.lenRatios.length < 3) return 0.95;
    const s = [...this.lenRatios].sort((a, b) => a - b);
    return s[Math.floor(s.length * 0.6)];
  }

  detect(
    ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
    W: number,
    H: number,
    p: NLm,
    maxCands: number,
    bg: Background | null = null,
  ): ShaftCandidate[] {
    const h = weightedMid(p[LM.leftWrist], p[LM.leftWrist].visibility ?? 1, p[LM.rightWrist], p[LM.rightWrist].visibility ?? 1);
    const hx = h.x * W;
    const hy = h.y * H;
    const sx = ((p[LM.leftShoulder].x + p[LM.rightShoulder].x) / 2) * W;
    const sy = ((p[LM.leftShoulder].y + p[LM.rightShoulder].y) / 2) * H;
    const px = ((p[LM.leftHip].x + p[LM.rightHip].x) / 2) * W;
    const py = ((p[LM.leftHip].y + p[LM.rightHip].y) / 2) * H;
    const torso = Math.hypot(sx - px, sy - py);
    if (!Number.isFinite(torso) || torso < 20 || !Number.isFinite(hx)) return [];
    const L = torso * 1.9; // 手到桿頭的預估距離

    // 讀取雙手周圍區域的灰階
    const R = Math.ceil(L * 1.45);
    const x0 = Math.max(0, Math.floor(hx - R));
    const y0 = Math.max(0, Math.floor(hy - R));
    const x1 = Math.min(W, Math.ceil(hx + R));
    const y1 = Math.min(H, Math.ceil(hy + R));
    const rw = x1 - x0;
    const rh = y1 - y0;
    if (rw < 10 || rh < 10) return [];
    const data = ctx.getImageData(x0, y0, rw, rh).data;
    if (this.gray.length < rw * rh) this.gray = new Float32Array(rw * rh);
    const g = this.gray;
    for (let i = 0, j = 0; i < rw * rh; i++, j += 4) g[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
    const at = (x: number, y: number) => {
      const xi = Math.round(x) - x0;
      const yi = Math.round(y) - y0;
      if (xi < 0 || yi < 0 || xi >= rw || yi >= rh) return NaN;
      return g[yi * rw + xi];
    };

    // 脊線強度：中心與兩側差異大、兩側彼此相近（排除一般邊緣）
    const off = Math.max(2, Math.round(L / 130));
    const ridge = (cx: number, cy: number, nx: number, ny: number) => {
      const c = at(cx, cy);
      const a = at(cx + nx * off, cy + ny * off);
      const b = at(cx - nx * off, cy - ny * off);
      if (Number.isNaN(c) || Number.isNaN(a) || Number.isNaN(b)) return NaN;
      return Math.max(0, (Math.abs(c - a) + Math.abs(c - b) - Math.abs(a - b)) / 2);
    };

    const rIn = 0.18 * L;
    const rOut = 0.85 * L;
    const step = 1.5;
    // 扣除兩側紋理後的細線強度
    const thinRidge = (cx: number, cy: number, nx: number, ny: number) => {
      const v = ridge(cx, cy, nx, ny);
      if (Number.isNaN(v)) return NaN;
      const o2 = off * 3;
      const v1 = ridge(cx + nx * o2, cy + ny * o2, nx, ny);
      const v2 = ridge(cx - nx * o2, cy - ny * o2, nx, ny);
      return Math.max(0, v - Math.max(Number.isNaN(v1) ? 0 : v1, Number.isNaN(v2) ? 0 : v2));
    };
    // 桿身朝向鏡頭時畫面上會縮短：分別以不同長度積分，取最佳（越短略扣分）
    const SPANS = [
      { end: 0.85, weight: 1 },
      { end: 0.65, weight: 0.93 },
      { end: 0.48, weight: 0.85 },
    ];
    // 雙手中心的估計可能偏離實際握把數十像素，允許直線有橫向偏移
    const OFFSETS = [0, -0.06, 0.06, -0.12, 0.12].map((v) => v * L);
    const lineScore = (rf: typeof ridge, th: number, k: number, stepSize: number, minFrac: number, lo = 0) => {
      const dx = Math.cos(th);
      const dy = Math.sin(th);
      const nx = -dy;
      const ny = dx;
      const o2 = off * 3 * k;
      const ox = (hx + nx * lo) * k;
      const oy = (hy + ny * lo) * k;
      // 累積值，依距離分段取平均
      let s = 0;
      let c = 0;
      let best = 0;
      let si = SPANS.length - 1;
      for (let r = rIn * k; r <= rOut * k + 1e-6; r += stepSize) {
        const cx = ox + dx * r;
        const cy = oy + dy * r;
        const v = rf(cx, cy, nx, ny);
        if (!Number.isNaN(v)) {
          // 細線：中心脊線強、旁邊弱；一整片紋理（樹林、草地）旁邊也強，會被扣掉
          const v1 = rf(cx + nx * o2, cy + ny * o2, nx, ny);
          const v2 = rf(cx - nx * o2, cy - ny * o2, nx, ny);
          const side = Math.max(Number.isNaN(v1) ? 0 : v1, Number.isNaN(v2) ? 0 : v2);
          s += Math.max(0, v - side);
          c++;
        }
        while (si >= 0 && r >= SPANS[si].end * L * k - stepSize / 2) {
          const span = ((SPANS[si].end * L - rIn) * k) / stepSize;
          // 射線大部分落在畫面外時不可信
          if (c > span * minFrac) best = Math.max(best, (s / c) * SPANS[si].weight);
          si--;
        }
      }
      return best;
    };
    for (let k = 0; k < N_ANGLES; k++) {
      const th = k * DEG;
      this.score[k] = 0;
      this.bestOffset[k] = 0;
      for (let i = 0; i < OFFSETS.length; i++) {
        // 偏移越大略為扣分，避免無關的平行線
        const v = lineScore(ridge, th, 1, step, 0.6, OFFSETS[i]) * (1 - 0.04 * i);
        if (v > this.score[k]) {
          this.score[k] = v;
          this.bestOffset[k] = OFFSETS[i];
        }
      }
    }

    // 背景影像上的同一條線
    let bgRidge: typeof ridge | null = null;
    if (bg) {
      const bOff = Math.max(1, Math.round(off * bg.scale));
      const bat = (x: number, y: number) => {
        const xi = Math.round(x);
        const yi = Math.round(y);
        if (xi < 0 || yi < 0 || xi >= bg.w || yi >= bg.h) return NaN;
        return bg.gray[yi * bg.w + xi];
      };
      bgRidge = (cx, cy, nx, ny) => {
        const c = bat(cx, cy);
        const a = bat(cx + nx * bOff, cy + ny * bOff);
        const b = bat(cx - nx * bOff, cy - ny * bOff);
        if (Number.isNaN(c) || Number.isNaN(a) || Number.isNaN(b)) return NaN;
        return Math.max(0, (Math.abs(c - a) + Math.abs(c - b) - Math.abs(a - b)) / 2);
      };
    }

    const sm = new Float32Array(N_ANGLES);
    for (let k = 0; k < N_ANGLES; k++) {
      sm[k] = (this.score[(k + N_ANGLES - 1) % N_ANGLES] + 2 * this.score[k] + this.score[(k + 1) % N_ANGLES]) / 4;
    }
    let mean = 0;
    let sq = 0;
    for (let k = 0; k < N_ANGLES; k++) {
      mean += sm[k];
      sq += sm[k] * sm[k];
    }
    mean /= N_ANGLES;
    const std = Math.sqrt(Math.max(sq / N_ANGLES - mean * mean, 1e-6));

    // 取局部最大值作為候選
    const peaks: number[] = [];
    for (let k = 0; k < N_ANGLES; k++) {
      let isMax = sm[k] > 0;
      for (let d = 1; d <= NMS_DEG && isMax; d++) {
        if (sm[(k + d) % N_ANGLES] > sm[k] || sm[(k - d + N_ANGLES) % N_ANGLES] > sm[k]) isMax = false;
      }
      if (isMax && (sm[k] - mean) / std > 1.5) peaks.push(k);
    }
    peaks.sort((a, b) => sm[b] - sm[a]);

    const out: ShaftCandidate[] = [];
    const picked = peaks.slice(0, maxCands);
    for (let pi = 0; pi < picked.length && out.length < maxCands; pi++) {
      const k = picked[pi];
      const z = (sm[k] - mean) / std;
      const lineConf = Math.min(1, Math.max(0.05, (z - 1.5) / 4));
      let th = k * DEG;
      let lo = this.bestOffset[k];
      // 最強的兩條線：在附近微調角度與橫向位置，讓後續沿線找桿頭更準
      if (pi < 2) ({ th, lo } = refineLine(thinRidge, hx, hy, th, lo, L, rIn));
      const ox = hx - Math.sin(th) * lo;
      const oy = hy + Math.cos(th) * lo;
      const bgRatio = bgRidge && bg ? lineScore(bgRidge, th, bg.scale, 1, 0.3, lo) / Math.max(this.score[k], 1e-6) : 0;

      const push = (x: number, y: number, conf: number, flags: number) => out.push({ x, y, conf, angle: th, flags, bgRatio });
      const along = (r: number) => ({ x: ox + Math.cos(th) * r, y: oy + Math.sin(th) * r });

      // 沿桿身逐段追蹤到末端（同時修正角度誤差）
      const tr = traceShaft(at, ox, oy, th, L, W, H);
      if (tr.outOfFrame) {
        // 桿身一路延伸到畫面邊界：桿頭在邊界上或畫面外，以過去量到的桿長估算（最多超出邊界 0.04L：
        // 多半只是桿頭貼著邊緣，且桿身因透視縮短時過去的桿長會高估）
        const q = tr.point(tr.exitAt + Math.min(Math.max(0, this.lenRatio() * L - tr.exitAt), 0.04 * L));
        push(q.x, q.y, lineConf * 0.85, CAND_OUT_OF_FRAME);
        continue;
      }
      if (tr.conf > 0) {
        let q = tr.point(tr.end);
        // 桿身末端是桿頸：最強的兩條線再往附近找桿頭區塊的中心
        if (pi < 2) q = refineHead(at, q.x, q.y, Math.cos(th), Math.sin(th), L) ?? q;
        push(q.x, q.y, lineConf * (0.6 + 0.4 * tr.conf), tr.conf > 0.3 ? CAND_HEAD : 0);
        if (pi === 0 && tr.conf > 0.6) {
          this.lenRatios.push(tr.end / L);
          if (this.lenRatios.length > 60) this.lenRatios.shift();
        }
        // 最強的線另外提供影像區塊法找到的桿頭位置，交給追蹤器以前後格判斷
        if (pi === 0 && out.length < maxCands) {
          const head = findHead(at, thinRidge, ox, oy, th, L, off, W, H);
          if (head.best && head.best.conf > 0.3 && Math.abs(head.best.r - tr.end) > 0.1 * L) {
            const q2 = along(head.best.r);
            push(q2.x, q2.y, lineConf * (0.6 + 0.4 * head.best.conf) * 0.7, CAND_HEAD);
          }
        }
        continue;
      }
      const head = findHead(at, thinRidge, ox, oy, th, L, off, W, H);
      if (head.outOfFrame) {
        const q = along(Math.max(head.exitAt, this.lenRatio() * L));
        push(q.x, q.y, lineConf * 0.85, CAND_OUT_OF_FRAME);
      } else if (head.best) {
        const q = along(head.best.r);
        push(q.x, q.y, lineConf * (0.6 + 0.4 * head.best.conf), head.best.conf > 0.3 ? CAND_HEAD : 0);
      } else {
        const q = along(this.findEnd(thinRidge, ox, oy, th, L, rIn, off, W, H).end);
        push(q.x, q.y, lineConf * 0.6, 0);
      }
    }
    return out;
  }

  /** 沿桿身方向找末端；桿身一路延伸到畫面邊界時，以過去量到的桿長估算 */
  private findEnd(
    ridge: (cx: number, cy: number, nx: number, ny: number) => number,
    hx: number,
    hy: number,
    th: number,
    L: number,
    rIn: number,
    off: number,
    W: number,
    H: number,
  ) {
    const dx = Math.cos(th);
    const dy = Math.sin(th);
    const prof: number[] = [];
    let exitAt = Infinity;
    for (let r = 0; r <= 1.5 * L; r += 1) {
      const qx = hx + dx * r;
      const qy = hy + dy * r;
      if (exitAt === Infinity && (qx < off || qy < off || qx >= W - off || qy >= H - off)) exitAt = r;
      const v = ridge(qx, qy, -dy, dx);
      prof.push(Number.isNaN(v) ? 0 : v);
    }
    const win = 6;
    const smooth = prof.map((_, i) => {
      let s = 0;
      let c = 0;
      for (let j = Math.max(0, i - win); j <= Math.min(prof.length - 1, i + win); j++) {
        s += prof[j];
        c++;
      }
      return s / c;
    });
    // 以靠近雙手的一段（必定是桿身）作為強度基準
    const refVals = smooth.slice(Math.round(rIn), Math.round(0.4 * L)).sort((a, b) => a - b);
    const ref = refVals[Math.floor(refVals.length / 2)] ?? 0;
    let end = Math.round(0.4 * L);
    for (let r = Math.round(0.4 * L); r < Math.min(smooth.length, exitAt); r++) {
      if (smooth[r] >= ref * 0.3) end = r;
      else if (r - end > 0.06 * L) break;
    }
    if (exitAt - end < 12) return { end: Math.round(Math.max(end, this.lenRatio() * L)), outOfFrame: true };
    return { end: Math.min(end, Math.round(1.35 * L)), outOfFrame: false };
  }
}

type RidgeFn = (cx: number, cy: number, nx: number, ny: number) => number;

/** 在初步角度附近微調（±1°、橫向 ±6px），讓線貼齊實際桿身 */
function refineLine(thin: RidgeFn, hx: number, hy: number, th0: number, lo0: number, L: number, rIn: number) {
  let best = { th: th0, lo: lo0, s: -1 };
  for (let da = -1; da <= 1.001; da += 0.5) {
    const th = th0 + (da * Math.PI) / 180;
    const dx = Math.cos(th);
    const dy = Math.sin(th);
    const nx = -dy;
    const ny = dx;
    for (let dl = -6; dl <= 6; dl += 1) {
      const lo = lo0 + dl;
      const ox = hx + nx * lo;
      const oy = hy + ny * lo;
      let s = 0;
      let c = 0;
      for (let r = rIn; r <= 0.6 * L; r += 3) {
        const v = thin(ox + dx * r, oy + dy * r, nx, ny);
        if (Number.isNaN(v)) continue;
        s += v;
        c++;
      }
      if (c && s / c > best.s) best = { th, lo, s: s / c };
    }
  }
  return best;
}

interface HeadHit {
  r: number;
  score: number;
  conf: number;
}

/**
 * 沿桿身找桿頭：桿頭是一塊與周圍對比明顯的區塊，前方連著桿身、後方桿身不再延續。
 * 分數 = 區塊對比 × 前方桿身連續度 × (1 − 0.8 × 後方桿身延續度)
 */
function findHead(at: (x: number, y: number) => number, thin: RidgeFn, ox: number, oy: number, th: number, L: number, off: number, W: number, H: number) {
  const dx = Math.cos(th);
  const dy = Math.sin(th);
  const nx = -dy;
  const ny = dx;
  const step = 2;
  const maxR = 1.5 * L;
  const n = Math.floor(maxR / step) + 1;
  // 桿身細線強度剖面（橫向 ±1px 取最大），並記錄射線離開畫面的位置
  const R = new Float32Array(n);
  let exitAt = Infinity;
  for (let i = 0; i < n; i++) {
    const r = i * step;
    const cx = ox + dx * r;
    const cy = oy + dy * r;
    if (exitAt === Infinity && (cx < off || cy < off || cx >= W - off || cy >= H - off)) exitAt = r;
    let m = 0;
    for (let e = -1; e <= 1; e++) {
      const v = thin(cx + nx * e, cy + ny * e, nx, ny);
      if (!Number.isNaN(v) && v > m) m = v;
    }
    R[i] = m;
  }
  const refVals = Array.from(R.slice(Math.round((0.18 * L) / step), Math.round((0.5 * L) / step))).sort((a, b) => a - b);
  const ref = Math.max(refVals[refVals.length >> 1] ?? 0, 1);
  // 前綴和（上限 2×ref，避免極端值主導）
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + Math.min(R[i], ref * 2);
  const meanR = (a: number, b: number) => {
    const i0 = Math.max(0, Math.round(a / step));
    const i1 = Math.min(n - 1, Math.round(b / step));
    return i1 >= i0 ? (pre[i1 + 1] - pre[i0]) / (i1 - i0 + 1) : 0;
  };

  // 桿身一路到畫面邊界：可能在畫面外（稍後若在畫面內找到清楚的桿頭則以桿頭為準）
  const reachesEdge = exitAt < 1.4 * L && meanR(exitAt - 0.15 * L, exitAt - 2) > 0.5 * ref;

  const rho = Math.max(4, Math.round(0.045 * L));
  const disk = (cx: number, cy: number, r0: number, r1: number) => {
    let s = 0;
    let c = 0;
    for (let a = -r1; a <= r1; a += 2)
      for (let b = -r1; b <= r1; b += 2) {
        const d = Math.hypot(a, b);
        if (d < r0 || d > r1) continue;
        const v = at(cx + a, cy + b);
        if (!Number.isNaN(v)) {
          s += v;
          c++;
        }
      }
    return c ? s / c : NaN;
  };
  const scores: HeadHit[] = [];
  for (let r = 0.4 * L; r <= Math.min(1.45 * L, exitAt - rho); r += step) {
    const cx = ox + dx * r;
    const cy = oy + dy * r;
    const blob = Math.abs(disk(cx, cy, 0, rho) - disk(cx, cy, rho * 1.6, rho * 2.6));
    if (Number.isNaN(blob)) continue;
    const before = Math.min(1, meanR(r - 0.3 * L, r - 1.5 * rho) / ref);
    const after = Math.min(1, meanR(r + 2 * rho, r + 0.2 * L) / ref);
    const score = blob * before * (1 - 0.8 * after);
    scores.push({ r, score, conf: Math.min(1, Math.max(0, (score - 6) / 30)) * Math.min(1, before / 0.5) });
  }
  if (!scores.length) return { outOfFrame: reachesEdge, exitAt, best: null as HeadHit | null, second: null as HeadHit | null };
  let best = scores[0];
  for (const s of scores) if (s.score > best.score) best = s;
  // 貼近邊緣的桿頭：只有在畫面內找到清楚的桿頭時才不算出界
  if (reachesEdge && best.conf < 0.5) return { outOfFrame: true, exitAt, best: null, second: null };
  let second: HeadHit | null = null;
  for (const s of scores) {
    if (Math.abs(s.r - best.r) <= 3 * rho) continue;
    // 只取局部最大值
    if (scores.some((o) => Math.abs(o.r - s.r) <= 2 * step && o.score > s.score)) continue;
    if (s.score > 0.6 * best.score && (!second || s.score > second.score)) second = s;
  }
  return { outOfFrame: false, exitAt, best, second };
}

/**
 * 沿桿身逐段追蹤：在預測的橫向位置附近，以「沿線段平均的對比」找桿身
 * （隨機紋理平均後互相抵消、桿身則持續累加；取絕對值以適應桿身在草地/墊子上明暗反轉），
 * 並以加權最小平方逐步修正直線，直到桿身不再延續，末端即桿頭。
 */
function traceShaft(at: (x: number, y: number) => number, ox: number, oy: number, th: number, L: number, W: number, H: number) {
  const dx = Math.cos(th);
  const dy = Math.sin(th);
  const nx = -dy;
  const ny = dx;
  const step = Math.max(2, Math.round(L / 65));
  const win = Math.max(4, Math.round(L / 45));
  const d = Math.max(2, Math.round(L / 90));
  const search = Math.max(2, Math.round(L / 90));
  const maxGap = 0.1 * L;
  const seg = (r: number, e: number, slope: number) => {
    let s = 0;
    let c = 0;
    for (let t = -win; t <= win; t++) {
      const ee = e + slope * t;
      const x = ox + dx * (r + t) + nx * ee;
      const y = oy + dy * (r + t) + ny * ee;
      const v = at(x, y) - (at(x + nx * d, y + ny * d) + at(x - nx * d, y - ny * d)) / 2;
      if (!Number.isNaN(v)) {
        s += v;
        c++;
      }
    }
    return c > win ? Math.abs(s / c) : 0;
  };
  // 橫向位置 e = a + b·r（對原點附近、斜率 0 加弱先驗）
  let Sw = 2;
  let Sr = 0;
  let Se = 0;
  let Srr = 2 * (0.3 * L) ** 2;
  let Sre = 0;
  const fit = () => {
    const det = Sw * Srr - Sr * Sr;
    return det > 1e-9 ? { a: (Se * Srr - Sr * Sre) / det, b: (Sw * Sre - Sr * Se) / det } : { a: 0, b: 0 };
  };
  const refVals: number[] = [];
  let ref = 0;
  let last = NaN;
  let exitAt = Infinity;
  let hits = 0;
  let total = 0;
  for (let r = 0.18 * L; r <= 1.45 * L; r += step) {
    const { a, b } = fit();
    const ep = a + b * r;
    const cx = ox + dx * r + nx * ep;
    const cy = oy + dy * r + ny * ep;
    if (cx < d || cy < d || cx >= W - d || cy >= H - d) {
      exitAt = r;
      break;
    }
    let best = { e: ep, v: 0 };
    for (let e = ep - search; e <= ep + search + 1e-6; e += 1) {
      const v = seg(r, e, b);
      if (v > best.v) best = { e, v };
    }
    const near = r < 0.5 * L;
    if (near) {
      refVals.push(best.v);
      ref = [...refVals].sort((x, y) => x - y)[refVals.length >> 1];
    }
    total++;
    if (best.v > 0.3 * ref && ref > 0) {
      const w = Math.min(best.v / ref, 1.5);
      Sw += w;
      Sr += w * r;
      Se += w * best.e;
      Srr += w * r * r;
      Sre += w * r * best.e;
      last = r;
      hits++;
    } else if (!near && r - last > maxGap) break;
  }
  const { a, b } = fit();
  const point = (r: number) => {
    const e = a + b * r;
    return { x: ox + dx * r + nx * e, y: oy + dy * r + ny * e };
  };
  // 桿身一路延續到畫面邊緣才算出界（桿頭貼近邊緣但仍在畫面內時，末端會在邊緣前停下）
  const outOfFrame = Number.isFinite(exitAt) && last >= exitAt - 1.5 * step;
  // 信心：桿身沿途的連續程度，且末端要離手夠遠
  const support = total ? hits / total : 0;
  const conf = !Number.isFinite(last) || last < 0.3 * L || ref <= 0 ? 0 : Math.min(1, Math.max(0, (support - 0.3) / 0.5));
  return { end: last, exitAt, outOfFrame, conf, point };
}

/**
 * 桿頭中心：桿身末端是桿頸，桿頭本體往趾端延伸。在末端附近找「內框與外框亮度差」最大的位置
 * （以積分影像計算方框平均，只計畫面內的像素），距離末端越遠扣分越多。
 */
function refineHead(at: (x: number, y: number) => number, ex: number, ey: number, dirx: number, diry: number, L: number) {
  const rho = Math.max(3, Math.round(0.035 * L));
  const win = Math.max(4, Math.round(0.08 * L));
  const ro = Math.round(2.3 * rho);
  const ri = Math.round(1.5 * rho);
  const R = win + ro + 1;
  const x0 = Math.round(ex) - R;
  const y0 = Math.round(ey) - R;
  const S = 2 * R + 1;
  // 積分影像：亮度總和與有效像素數（多一列一行的零）
  const I = new Float64Array((S + 1) * (S + 1));
  const N = new Float64Array((S + 1) * (S + 1));
  for (let j = 0; j < S; j++) {
    let row = 0;
    let cnt = 0;
    for (let i = 0; i < S; i++) {
      const v = at(x0 + i, y0 + j);
      if (!Number.isNaN(v)) {
        row += v;
        cnt++;
      }
      const k = (j + 1) * (S + 1) + i + 1;
      I[k] = I[k - S - 1] + row;
      N[k] = N[k - S - 1] + cnt;
    }
  }
  const box = (A: Float64Array, cx: number, cy: number, r: number) => {
    const a = cx - r;
    const b = cy - r;
    const c = cx + r + 1;
    const d = cy + r + 1;
    return A[d * (S + 1) + c] - A[b * (S + 1) + c] - A[d * (S + 1) + a] + A[b * (S + 1) + a];
  };
  const nIn = (2 * rho + 1) ** 2;
  const nRing = (2 * ro + 1) ** 2 - (2 * ri + 1) ** 2;
  const penPx = 1 / (0.004 * L);
  let best = { dx: 0, dy: 0, s: -Infinity };
  for (let dy = -win; dy <= win; dy++)
    for (let dx = -win; dx <= win; dx++) {
      const d = Math.hypot(dx, dy);
      // 不往桿身方向回頭太多
      if (d > win || dx * dirx + dy * diry < -0.3 * win) continue;
      const cx = R + dx;
      const cy = R + dy;
      const cIn = box(N, cx, cy, rho);
      const cRing = box(N, cx, cy, ro) - box(N, cx, cy, ri);
      if (cIn < 0.6 * nIn || cRing < 0.4 * nRing) continue;
      const inner = box(I, cx, cy, rho) / cIn;
      const ring = (box(I, cx, cy, ro) - box(I, cx, cy, ri)) / cRing;
      const sc = Math.abs(inner - ring) - d * penPx;
      if (sc > best.s) best = { dx, dy, s: sc };
    }
  return Number.isFinite(best.s) ? { x: Math.round(ex) + best.dx, y: Math.round(ey) + best.dy } : null;
}
