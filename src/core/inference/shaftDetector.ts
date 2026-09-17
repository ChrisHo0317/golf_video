import { CAND_OUT_OF_FRAME } from '../../types';
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
    for (const k of peaks.slice(0, maxCands)) {
      const z = (sm[k] - mean) / std;
      const conf = Math.min(1, Math.max(0.05, (z - 1.5) / 4));
      const th = k * DEG;
      const lo = this.bestOffset[k];
      const ox = hx - Math.sin(th) * lo;
      const oy = hy + Math.cos(th) * lo;
      const { end, outOfFrame } = this.findEnd(thinRidge, ox, oy, th, L, rIn, off, W, H);
      if (!outOfFrame && out.length === 0 && conf > 0.5) {
        this.lenRatios.push(end / L);
        if (this.lenRatios.length > 60) this.lenRatios.shift();
      }
      const bgRatio = bgRidge && bg ? lineScore(bgRidge, th, bg.scale, 1, 0.3, lo) / Math.max(this.score[k], 1e-6) : 0;
      out.push({
        x: ox + Math.cos(th) * end,
        y: oy + Math.sin(th) * end,
        conf: outOfFrame ? conf * 0.85 : conf,
        angle: th,
        flags: outOfFrame ? CAND_OUT_OF_FRAME : 0,
        bgRatio,
      });
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
