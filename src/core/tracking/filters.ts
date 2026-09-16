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
      for (let j = 0; j < i; j++) out[j] = v[i];
    } else if (i - prev > 1 && t[i] - t[prev] <= maxGapSec) {
      for (let j = prev + 1; j < i; j++) {
        const r = (t[j] - t[prev]) / (t[i] - t[prev]);
        out[j] = v[prev] + r * (v[i] - v[prev]);
      }
    }
    prev = i;
  }
  if (prev !== -1) for (let j = prev + 1; j < n; j++) out[j] = v[prev];
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
