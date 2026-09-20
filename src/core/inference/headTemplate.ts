import type { Pt } from '../landmarks';

export interface TemplateHit {
  x: number;
  y: number;
  /** 正規化相關係數（0~1） */
  ncc: number;
}

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/**
 * 桿頭模板追蹤：桿頭在準備、頂點、收桿等慢速段幾乎靜止或緩慢移動，
 * 以影像模板比對（NCC）逐格追蹤可達到 1~3 px 的精度。
 * 以「連續數格在同一位置清楚找到桿頭、雙手移動緩慢」為條件初始化，相似度下降即停止。
 */
export class HeadTemplateTracker {
  private tmpl: Float32Array | null = null;
  private half = 8;
  private pos: Pt = { x: 0, y: 0 };
  private vel: Pt = { x: 0, y: 0 };
  private lastT = 0;
  private seeds: { p: Pt; t: number }[] = [];

  get active() {
    return this.tmpl !== null;
  }

  reset() {
    this.tmpl = null;
    this.seeds = [];
  }

  /** 提供清楚的桿頭偵測作為初始化種子（慢速時） */
  seed(ctx: Ctx, p: Pt, t: number, L: number, handsSlow: boolean) {
    if (this.tmpl) return;
    if (!handsSlow) {
      this.seeds = [];
      return;
    }
    const tol = Math.max(3, 0.03 * L);
    this.seeds = this.seeds.filter((s) => t - s.t < 0.3);
    if (this.seeds.length && Math.hypot(this.seeds[this.seeds.length - 1].p.x - p.x, this.seeds[this.seeds.length - 1].p.y - p.y) > tol) this.seeds = [];
    this.seeds.push({ p, t });
    if (this.seeds.length >= 3) {
      this.half = Math.max(6, Math.round(0.055 * L));
      const t0 = grab(ctx, p.x, p.y, this.half);
      if (t0) {
        this.tmpl = t0;
        this.pos = { ...p };
        this.vel = { x: 0, y: 0 };
        this.lastT = t;
      }
      this.seeds = [];
    }
  }

  /** 追蹤到這一格；失敗時回傳 null 並停止追蹤 */
  track(ctx: Ctx, t: number, hands: Pt, L: number): TemplateHit | null {
    if (!this.tmpl) return null;
    const dt = Math.max(t - this.lastT, 1e-3);
    const pred = { x: this.pos.x + this.vel.x * dt, y: this.pos.y + this.vel.y * dt };
    const speed = Math.hypot(this.vel.x, this.vel.y) * dt;
    const search = Math.min(Math.round(0.3 * L), Math.round(12 + 1.5 * speed));
    const h = this.half;
    const area = grab(ctx, pred.x, pred.y, h + search);
    if (!area) return this.lose();
    const A = 2 * (h + search) + 1;
    const S = 2 * h + 1;
    const scoreAt = (ox: number, oy: number) => ncc(this.tmpl!, area, A, S, ox + search, oy + search);
    // 粗搜（間隔 2）再細搜
    let best = { x: 0, y: 0, s: -2 };
    for (let oy = -search; oy <= search; oy += 2)
      for (let ox = -search; ox <= search; ox += 2) {
        const s = scoreAt(ox, oy);
        if (s > best.s) best = { x: ox, y: oy, s };
      }
    const cx = best.x;
    const cy = best.y;
    for (let oy = Math.max(-search, cy - 2); oy <= Math.min(search, cy + 2); oy++)
      for (let ox = Math.max(-search, cx - 2); ox <= Math.min(search, cx + 2); ox++) {
        const s = scoreAt(ox, oy);
        if (s > best.s) best = { x: ox, y: oy, s };
      }
    const nx = pred.x + best.x;
    const ny = pred.y + best.y;
    const r = Math.hypot(nx - hands.x, ny - hands.y);
    if (best.s < 0.72 || r < 0.3 * L || r > 1.7 * L) return this.lose();
    // 更新速度（平滑）與模板（緩慢跟隨外觀變化）
    const vx = (nx - this.pos.x) / dt;
    const vy = (ny - this.pos.y) / dt;
    this.vel = { x: 0.5 * this.vel.x + 0.5 * vx, y: 0.5 * this.vel.y + 0.5 * vy };
    this.pos = { x: nx, y: ny };
    this.lastT = t;
    const cur = grab(ctx, nx, ny, h);
    if (cur) for (let i = 0; i < cur.length; i++) this.tmpl[i] = 0.9 * this.tmpl[i] + 0.1 * cur[i];
    return { x: nx, y: ny, ncc: best.s };
  }

  private lose() {
    this.tmpl = null;
    this.seeds = [];
    return null;
  }
}

function grab(ctx: Ctx, cx: number, cy: number, half: number): Float32Array | null {
  const x0 = Math.round(cx) - half;
  const y0 = Math.round(cy) - half;
  const size = 2 * half + 1;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  if (x0 < 0 || y0 < 0 || x0 + size > W || y0 + size > H) return null;
  const d = ctx.getImageData(x0, y0, size, size).data;
  const g = new Float32Array(size * size);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return g;
}

/** 模板 t（S×S）與 area（A×A）中以 (ox, oy) 為左上角的區塊之正規化相關係數 */
function ncc(t: Float32Array, area: Float32Array, A: number, S: number, ox: number, oy: number): number {
  let st = 0;
  let sa = 0;
  const n = S * S;
  for (let j = 0; j < S; j++) {
    const row = (oy + j) * A + ox;
    for (let i = 0; i < S; i++) {
      st += t[j * S + i];
      sa += area[row + i];
    }
  }
  const mt = st / n;
  const ma = sa / n;
  let num = 0;
  let dt = 0;
  let da = 0;
  for (let j = 0; j < S; j++) {
    const row = (oy + j) * A + ox;
    for (let i = 0; i < S; i++) {
      const a = t[j * S + i] - mt;
      const b = area[row + i] - ma;
      num += a * b;
      dt += a * a;
      da += b * b;
    }
  }
  return num / Math.sqrt(dt * da + 1e-9);
}
