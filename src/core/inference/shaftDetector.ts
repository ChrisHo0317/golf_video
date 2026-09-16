import { LM, weightedMid, type Pt } from '../landmarks';

type NLm = { x: number; y: number; visibility?: number }[];

export interface ShaftDetection {
  /** 分析畫布像素座標 */
  x: number;
  y: number;
  conf: number;
  angle: number;
}

const DEG = Math.PI / 180;
const N_ANGLES = 360;

/**
 * 不需訓練的桿身偵測：
 * 以雙手為圓心，對每個方向沿射線計算「細亮線／細暗線」的脊線強度，
 * 找出最像桿身的方向，再沿該方向找桿身末端作為桿頭位置。
 * 高速下桿時桿身會模糊，偵測不到的格交給追蹤器補點。
 */
export class ShaftDetector {
  private prevAngle: number | null = null;
  private prevT = -1;
  private gray = new Float32Array(0);
  private score = new Float32Array(N_ANGLES);
  /** 桿身完整在畫面內時量到的長度（相對 L），用於桿頭出界時估算 */
  private lenRatios: number[] = [];

  reset() {
    this.prevAngle = null;
    this.prevT = -1;
    this.lenRatios = [];
  }

  private lenRatio() {
    if (this.lenRatios.length < 3) return 0.95;
    const s = [...this.lenRatios].sort((a, b) => a - b);
    return s[Math.floor(s.length * 0.6)];
  }

  detect(ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, W: number, H: number, p: NLm, time: number): ShaftDetection | null {
    const h = weightedMid(p[LM.leftWrist], p[LM.leftWrist].visibility ?? 1, p[LM.rightWrist], p[LM.rightWrist].visibility ?? 1);
    const hx = h.x * W;
    const hy = h.y * H;
    const sx = ((p[LM.leftShoulder].x + p[LM.rightShoulder].x) / 2) * W;
    const sy = ((p[LM.leftShoulder].y + p[LM.rightShoulder].y) / 2) * H;
    const px = ((p[LM.leftHip].x + p[LM.rightHip].x) / 2) * W;
    const py = ((p[LM.leftHip].y + p[LM.rightHip].y) / 2) * H;
    const torso = Math.hypot(sx - px, sy - py);
    if (!Number.isFinite(torso) || torso < 20 || !Number.isFinite(hx)) return null;
    const L = torso * 1.9; // 手到桿頭的預估距離

    // 讀取雙手周圍區域的灰階
    const R = Math.ceil(L * 1.45);
    const x0 = Math.max(0, Math.floor(hx - R));
    const y0 = Math.max(0, Math.floor(hy - R));
    const x1 = Math.min(W, Math.ceil(hx + R));
    const y1 = Math.min(H, Math.ceil(hy + R));
    const rw = x1 - x0;
    const rh = y1 - y0;
    if (rw < 10 || rh < 10) return null;
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

    // 排除往手臂方向的角度（前臂本身也是長條狀）
    const armDirs: number[] = [];
    for (const [e, w] of [
      [LM.leftElbow, LM.leftWrist],
      [LM.rightElbow, LM.rightWrist],
    ] as const) {
      armDirs.push(Math.atan2((p[e].y - p[w].y) * H, (p[e].x - p[w].x) * W));
    }

    const rIn = 0.18 * L;
    const rOut = 0.85 * L;
    const step = 1.5;
    for (let k = 0; k < N_ANGLES; k++) {
      const th = k * DEG;
      if (armDirs.some((a) => Math.abs(angDiff(th, a)) < 28 * DEG)) {
        this.score[k] = 0;
        continue;
      }
      const dx = Math.cos(th);
      const dy = Math.sin(th);
      let s = 0;
      let c = 0;
      const nx = -dy;
      const ny = dx;
      const o2 = off * 3;
      for (let r = rIn; r <= rOut; r += step) {
        const cx = hx + dx * r;
        const cy = hy + dy * r;
        const v = ridge(cx, cy, nx, ny);
        if (Number.isNaN(v)) continue;
        // 細線：中心脊線強、旁邊弱；一整片紋理（樹林、草地）旁邊也強，會被扣掉
        const v1 = ridge(cx + nx * o2, cy + ny * o2, nx, ny);
        const v2 = ridge(cx - nx * o2, cy - ny * o2, nx, ny);
        const side = Math.max(Number.isNaN(v1) ? 0 : v1, Number.isNaN(v2) ? 0 : v2);
        s += Math.max(0, v - side);
        c++;
      }
      // 射線大部分落在畫面外時不可信
      this.score[k] = c > ((rOut - rIn) / step) * 0.6 ? s / c : 0;
    }

    // 角度平滑 + 與前一格的連續性
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

    const dt = this.prevT >= 0 ? time - this.prevT : Infinity;
    let best = -1;
    let bestVal = -Infinity;
    for (let k = 0; k < N_ANGLES; k++) {
      let v = sm[k];
      if (this.prevAngle !== null && dt < 0.2) {
        // 揮桿角速度上限約 2000°/s
        const lim = Math.max(40, 2000 * dt) * DEG;
        const d = Math.abs(angDiff(k * DEG, this.prevAngle));
        v *= 0.6 + 0.4 / (1 + (d / lim) ** 2);
      }
      if (v > bestVal) {
        bestVal = v;
        best = k;
      }
    }
    const z = (sm[best] - mean) / std;
    const conf = Math.min(1, Math.max(0, (z - 2.5) / 3));
    if (conf <= 0) {
      this.prevT = time;
      return null;
    }

    // 沿桿身方向找末端
    const th = best * DEG;
    const dx = Math.cos(th);
    const dy = Math.sin(th);
    const prof: number[] = [];
    let exitAt = Infinity; // 射線離開畫面的距離
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
    const refVals = smooth.slice(Math.round(rIn), Math.round(0.7 * L)).sort((a, b) => a - b);
    const ref = refVals[Math.floor(refVals.length / 2)] ?? 0;
    let end = Math.round(0.75 * L);
    for (let r = Math.round(0.6 * L); r < Math.min(smooth.length, exitAt); r++) {
      if (smooth[r] >= ref * 0.35) end = r;
      else if (r - end > 0.08 * L) break;
    }
    let confScale = 1;
    if (exitAt - end < 12) {
      // 桿身一路延伸到畫面邊界：桿頭在畫面外，以過去量到的桿長估算
      end = Math.round(Math.max(end, this.lenRatio() * L));
      confScale = 0.8;
    } else {
      end = Math.min(end, Math.round(1.35 * L));
      this.lenRatios.push(end / L);
      if (this.lenRatios.length > 60) this.lenRatios.shift();
    }

    this.prevAngle = th;
    this.prevT = time;
    const head: Pt = { x: hx + dx * end, y: hy + dy * end };
    return { x: head.x, y: head.y, conf: (0.35 + 0.5 * conf) * confScale, angle: th };
  }
}

function angDiff(a: number, b: number) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
