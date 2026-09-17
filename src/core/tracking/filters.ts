/** One Euro Filter（Casiez 2012）：低速時強平滑、高速時低延遲 */
export class OneEuroFilter {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev: number | null = null;

  constructor(
    private minCutoff = 1.0,
    private beta = 0.02,
    private dCutoff = 1.0,
  ) {}

  private static alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  reset() {
    this.xPrev = null;
    this.tPrev = null;
    this.dxPrev = 0;
  }

  filter(x: number, t: number): number {
    // 缺值不更新狀態，避免 NaN 汙染之後所有輸出
    if (!Number.isFinite(x)) return NaN;
    if (this.xPrev === null || this.tPrev === null || t <= this.tPrev) {
      this.xPrev = x;
      this.tPrev = t;
      return x;
    }
    const dt = t - this.tPrev;
    const dx = (x - this.xPrev) / dt;
    const aD = OneEuroFilter.alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = OneEuroFilter.alpha(cutoff, dt);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    this.tPrev = t;
    return xHat;
  }
}

/** 以前後向 One Euro 取平均，消除相位延遲（離線處理可用） */
export function zeroPhaseOneEuro(values: Float64Array, t: Float64Array, minCutoff: number, beta: number): Float64Array {
  const n = values.length;
  const fwd = new Float64Array(n);
  const bwd = new Float64Array(n);
  const f = new OneEuroFilter(minCutoff, beta);
  for (let i = 0; i < n; i++) fwd[i] = f.filter(values[i], t[i]);
  f.reset();
  const tMax = t[n - 1];
  for (let i = n - 1; i >= 0; i--) bwd[i] = f.filter(values[i], tMax - t[i]);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = (fwd[i] + bwd[i]) / 2;
  return out;
}

/** 將 NaN 以線性插值補齊（頭尾以最近值延伸）；全部 NaN 時原樣返回 */
export function fillGapsLinear(v: Float64Array, t: Float64Array, maxGapSec = Infinity): Float64Array {
  const out = Float64Array.from(v);
  const n = v.length;
  let prev = -1;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(v[i])) continue;
    if (prev === -1) {
      for (let j = 0; j < i; j++) if (t[i] - t[j] <= maxGapSec) out[j] = v[i];
    } else if (i - prev > 1 && t[i] - t[prev] <= maxGapSec) {
      for (let j = prev + 1; j < i; j++) {
        const r = (t[j] - t[prev]) / (t[i] - t[prev]);
        out[j] = v[prev] + r * (v[i] - v[prev]);
      }
    }
    prev = i;
  }
  if (prev !== -1) for (let j = prev + 1; j < n; j++) if (t[j] - t[prev] <= maxGapSec) out[j] = v[prev];
  return out;
}

/** 中央差分速度（單位/秒） */
export function velocity(v: ArrayLike<number>, t: ArrayLike<number>): Float64Array {
  const n = v.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    const dt = t[b] - t[a];
    out[i] = dt > 0 ? (v[b] - v[a]) / dt : 0;
  }
  return out;
}

/** 移動平均（NaN 略過） */
export function movingAverage(v: ArrayLike<number>, radius: number): Float64Array {
  const n = v.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) {
      if (!Number.isNaN(v[j])) {
        s += v[j];
        c++;
      }
    }
    out[i] = c ? s / c : NaN;
  }
  return out;
}

/**
 * 2D 等加速度卡爾曼濾波（每軸獨立），狀態 [p, v, a]
 * 用於桿頭追蹤：量測缺失時純預測
 */
export class Kalman1D {
  x = [0, 0, 0];
  P = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  initialized = false;

  constructor(
    private q: number,
    private r: number,
  ) {}

  init(p: number) {
    this.x = [p, 0, 0];
    this.P = [
      [this.r, 0, 0],
      [0, 10, 0],
      [0, 0, 100],
    ];
    this.initialized = true;
  }

  predict(dt: number) {
    const F = [
      [1, dt, 0.5 * dt * dt],
      [0, 1, dt],
      [0, 0, 1],
    ];
    const x = this.x;
    this.x = [F[0][0] * x[0] + F[0][1] * x[1] + F[0][2] * x[2], x[1] + dt * x[2], x[2]];
    const FP = mul(F, this.P);
    const P = mul(FP, transpose(F));
    const q = this.q;
    // 連續白噪加加速度模型的簡化 Q
    P[0][0] += (q * dt ** 5) / 20;
    P[1][1] += (q * dt ** 3) / 3;
    P[2][2] += q * dt;
    this.P = P;
  }

  /** 返回創新量（innovation）的馬氏距離平方 */
  mahalanobis(z: number, rScale = 1): number {
    const S = this.P[0][0] + this.r * rScale;
    const y = z - this.x[0];
    return (y * y) / S;
  }

  update(z: number, rScale = 1) {
    const S = this.P[0][0] + this.r * rScale;
    const K = [this.P[0][0] / S, this.P[1][0] / S, this.P[2][0] / S];
    const y = z - this.x[0];
    this.x = [this.x[0] + K[0] * y, this.x[1] + K[1] * y, this.x[2] + K[2] * y];
    const P = this.P.map((row) => row.slice());
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) P[i][j] -= K[i] * this.P[0][j];
    this.P = P;
  }
}

function mul(A: number[][], B: number[][]): number[][] {
  const out = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) out[i][j] += A[i][k] * B[k][j];
  return out;
}

function transpose(A: number[][]): number[][] {
  return A[0].map((_, j) => A.map((row) => row[j]));
}

type M3 = number[][];

function m3inv(A: M3): M3 {
  const [a, b, c] = A[0];
  const [d, e, f] = A[1];
  const [g, h, i] = A[2];
  const A_ = e * i - f * h;
  const B_ = -(d * i - f * g);
  const C_ = d * h - e * g;
  const det = a * A_ + b * B_ + c * C_;
  const s = 1 / (Math.abs(det) < 1e-300 ? 1e-300 : det);
  return [
    [A_ * s, -(b * i - c * h) * s, (b * f - c * e) * s],
    [B_ * s, (a * i - c * g) * s, -(a * f - c * d) * s],
    [C_ * s, -(a * h - b * g) * s, (a * e - b * d) * s],
  ];
}

export interface RtsResult {
  /** 平滑後位置 */
  x: Float64Array;
  /** 速度（單位/秒） */
  v: Float64Array;
  /** 位置的變異數 */
  varX: Float64Array;
  /** 第一個與最後一個量測的索引（範圍外為常數延伸） */
  first: number;
  last: number;
}

/**
 * 等加速度模型的前向卡爾曼濾波 + 反向 RTS 平滑（前後慣性）
 * @param z 量測值，NaN 表示缺失
 * @param R 量測變異數
 * @param q 加加速度（jerk）的連續白噪強度
 */
export function rtsSmoothCA(z: ArrayLike<number>, R: ArrayLike<number>, t: ArrayLike<number>, q: number): RtsResult {
  const n = z.length;
  const x = new Float64Array(n).fill(NaN);
  const v = new Float64Array(n).fill(0);
  const varX = new Float64Array(n).fill(Infinity);
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(z[i])) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return { x, v, varX, first, last };

  const len = last - first + 1;
  const xp: number[][] = new Array(len);
  const Pp: M3[] = new Array(len);
  const xf: number[][] = new Array(len);
  const Pf: M3[] = new Array(len);
  const Fs: M3[] = new Array(len);

  let xs = [z[first], 0, 0];
  let P: M3 = [
    [R[first], 0, 0],
    [0, 1e4, 0],
    [0, 0, 1e7],
  ];
  for (let k = 0; k < len; k++) {
    const i = first + k;
    let xPred = xs;
    let PPred = P;
    if (k > 0) {
      const dt = Math.max(t[i] - t[i - 1], 1e-4);
      const F: M3 = [
        [1, dt, 0.5 * dt * dt],
        [0, 1, dt],
        [0, 0, 1],
      ];
      Fs[k] = F;
      xPred = [xs[0] + dt * xs[1] + 0.5 * dt * dt * xs[2], xs[1] + dt * xs[2], xs[2]];
      const dt2 = dt * dt;
      const dt3 = dt2 * dt;
      const Q: M3 = [
        [(dt3 * dt2) / 20, (dt2 * dt2) / 8, dt3 / 6],
        [(dt2 * dt2) / 8, dt3 / 3, dt2 / 2],
        [dt3 / 6, dt2 / 2, dt],
      ];
      PPred = mul(mul(F, P), transpose(F));
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) PPred[a][b] += Q[a][b] * q;
    }
    xp[k] = xPred;
    Pp[k] = PPred;
    if (Number.isFinite(z[i])) {
      const S = PPred[0][0] + R[i];
      const K = [PPred[0][0] / S, PPred[1][0] / S, PPred[2][0] / S];
      const y = z[i] - xPred[0];
      xs = [xPred[0] + K[0] * y, xPred[1] + K[1] * y, xPred[2] + K[2] * y];
      P = PPred.map((row, a) => row.map((val, b) => val - K[a] * PPred[0][b]));
    } else {
      xs = xPred;
      P = PPred;
    }
    xf[k] = xs;
    Pf[k] = P;
  }

  let sx = xf[len - 1];
  let sP = Pf[len - 1];
  x[last] = sx[0];
  v[last] = sx[1];
  varX[last] = sP[0][0];
  for (let k = len - 2; k >= 0; k--) {
    const C = mul(mul(Pf[k], transpose(Fs[k + 1])), m3inv(Pp[k + 1]));
    const dx = [sx[0] - xp[k + 1][0], sx[1] - xp[k + 1][1], sx[2] - xp[k + 1][2]];
    const nx = [0, 1, 2].map((a) => xf[k][a] + C[a][0] * dx[0] + C[a][1] * dx[1] + C[a][2] * dx[2]);
    const dP = Pp[k + 1].map((row, a) => row.map((val, b) => sP[a][b] - val));
    const nP = mul(mul(C, dP), transpose(C)).map((row, a) => row.map((val, b) => val + Pf[k][a][b]));
    sx = nx;
    sP = nP;
    const i = first + k;
    x[i] = sx[0];
    v[i] = sx[1];
    varX[i] = sP[0][0];
  }
  for (let i = 0; i < first; i++) x[i] = x[first];
  for (let i = last + 1; i < n; i++) x[i] = x[last];
  return { x, v, varX, first, last };
}

/**
 * 時間域高斯平滑（零相位，適用不等間距取樣）
 * @param selfWeight 每個取樣「保住自己原值」的權重（只作用在該格本身，不會影響鄰居），
 *   例如手動標記給很大的權重，清晰的量測給中等權重
 */
export function gaussianSmooth(
  v: ArrayLike<number>,
  t: ArrayLike<number>,
  sigma: number | ArrayLike<number>,
  selfWeight?: ArrayLike<number>,
): Float64Array {
  const n = v.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // sigma 可以是每個取樣各自的值（自適應平滑）
    const sigmaSec = typeof sigma === 'number' ? sigma : sigma[i];
    const reach = sigmaSec * 3;
    if (!Number.isFinite(v[i])) {
      out[i] = v[i];
      continue;
    }
    let s = 0;
    let ws = 0;
    for (let j = i; j >= 0 && t[i] - t[j] <= reach; j--) {
      if (!Number.isFinite(v[j])) continue;
      const g = Math.exp(-0.5 * ((t[i] - t[j]) / sigmaSec) ** 2) * (j === i && selfWeight ? selfWeight[i] : 1);
      s += g * v[j];
      ws += g;
    }
    for (let j = i + 1; j < n && t[j] - t[i] <= reach; j++) {
      if (!Number.isFinite(v[j])) continue;
      const g = Math.exp(-0.5 * ((t[j] - t[i]) / sigmaSec) ** 2);
      s += g * v[j];
      ws += g;
    }
    out[i] = ws > 0 ? s / ws : v[i];
  }
  return out;
}
