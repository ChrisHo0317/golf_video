/** 開發用：對指定格重跑桿身偵測並取得 findHead 內部剖面 */
import { ShaftDetector } from '../core/inference/shaftDetector';
import { N_LM } from '../core/landmarks';
import type { FrameData } from '../types';
import { cached as evalCached, type EvalLabel } from './clubEval';

// 目前偵錯的影片（推論結果由 clubEval 快取）
let VIDEO = '811257859.281721';
export function useVideo(name: string) {
  VIDEO = name;
}
const labelMap = new Map<string, EvalLabel[]>();
export async function loadLabels() {
  if (!labelMap.has(VIDEO)) labelMap.set(VIDEO, (await (await fetch(`/00_data/labels/${VIDEO}_clubhead_labels.json`)).json()).labels);
}
function cached(): { fd: FrameData; labels: EvalLabel[] } | null {
  const fd = evalCached(VIDEO);
  return fd ? { fd, labels: labelMap.get(VIDEO) ?? [] } : null;
}

async function frameCtx(f: number, W: number, H: number) {
  const fd = cached()!.fd;
  // 每次建立新的影片元素：共用同一個元素連續跳格時，偶爾會畫出舊的畫格
  const vid = document.createElement('video');
  vid.muted = true;
  vid.src = `/00_data/${VIDEO}.mp4`;
  await new Promise((r) => (vid.onloadeddata = r));
  vid.currentTime = fd.t[f] + 0.001;
  await new Promise((r) => (vid.onseeked = r));
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(vid, 0, 0, W, H);
  return ctx;
}

function pose(f: number) {
  const fd = cached()!.fd;
  const p = [];
  for (let k = 0; k < N_LM; k++) {
    const b = (f * N_LM + k) * 4;
    p.push({ x: fd.pose2d[b], y: fd.pose2d[b + 1], z: fd.pose2d[b + 2], visibility: fd.pose2d[b + 3] });
  }
  return p;
}

export async function debugFrame(f: number, W = 540, H = 960) {
  const ctx = await frameCtx(f, W, H);
  const g = globalThis as { __shaftDbg?: unknown[] };
  g.__shaftDbg = [];
  const out = new ShaftDetector().detect(ctx, W, H, pose(f) as never, 5, null);
  const dbg = g.__shaftDbg as { th: number; ox: number; oy: number; L: number }[];
  delete g.__shaftDbg;
  return { out, dbg, ctx };
}

let ABS = true;
let EOFF = [-2, -1, 0, 1, 2];
export function setE(v: number[]) {
  EOFF = v;
}
export function setAbs(v: boolean) {
  ABS = v;
}

/** 新方法原型：沿線段平均的帶號對比剖面，找桿身末端 */
export function lineProfile(ctx: CanvasRenderingContext2D, W: number, H: number, ox: number, oy: number, thDeg: number, L: number) {
  const img = ctx.getImageData(0, 0, W, H).data;
  const at = (x: number, y: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return NaN;
    const j = (yi * W + xi) * 4;
    return 0.299 * img[j] + 0.587 * img[j + 1] + 0.114 * img[j + 2];
  };
  const th = (thDeg * Math.PI) / 180;
  const dx = Math.cos(th);
  const dy = Math.sin(th);
  const nx = -dy;
  const ny = dx;
  const n = Math.floor(1.5 * L);
  const d = 3;
  const E = EOFF;
  // C[e][r]：該點中心與兩側平均之差
  const C = E.map(() => new Float32Array(n));
  let exitAt = Infinity;
  for (let r = 0; r < n; r++) {
    const cx = ox + dx * r;
    const cy = oy + dy * r;
    if (exitAt === Infinity && (cx < 2 || cy < 2 || cx >= W - 2 || cy >= H - 2)) exitAt = r;
    E.forEach((e, k) => {
      const x = cx + nx * e;
      const y = cy + ny * e;
      const c = at(x, y);
      const a = at(x + nx * d, y + ny * d);
      const b = at(x - nx * d, y - ny * d);
      C[k][r] = Number.isNaN(c + a + b) ? 0 : c - (a + b) / 2;
    });
  }
  const w = 6;
  const S = E.map((_, k) => {
    const pre = new Float64Array(n + 1);
    for (let r = 0; r < n; r++) pre[r + 1] = pre[r] + C[k][r];
    const out = new Float32Array(n);
    for (let r = 0; r < n; r++) {
      const a = Math.max(0, r - w);
      const b = Math.min(n - 1, r + w);
      out[r] = (pre[b + 1] - pre[a]) / (b - a + 1);
    }
    return out;
  });
  // 符號：靠近手的區段
  const r0 = Math.round(0.18 * L);
  const r1 = Math.round(0.5 * L);
  let pos = 0;
  let neg = 0;
  for (let r = r0; r < r1; r++) {
    let mx = 0;
    let mn = 0;
    for (let k = 0; k < E.length; k++) {
      mx = Math.max(mx, S[k][r]);
      mn = Math.min(mn, S[k][r]);
    }
    pos += mx;
    neg -= mn;
  }
  const sign = pos >= neg ? 1 : -1;
  const P = new Float32Array(n);
  const Pe = new Int8Array(n);
  for (let r = 0; r < n; r++) {
    let m = -Infinity;
    for (let k = 0; k < E.length; k++) {
      const v = ABS ? Math.abs(S[k][r]) : sign * S[k][r];
      if (v > m) {
        m = v;
        Pe[r] = E[k];
      }
    }
    P[r] = m;
  }
  const ref = Math.max(1, [...P.slice(r0, r1)].sort((a, b) => a - b)[(r1 - r0) >> 1]);
  for (let r = 0; r < n; r++) P[r] /= ref;
  return { P, Pe, ref, sign, exitAt };
}

/** 以剖面找末端：前段平均 − 後段平均最大處 */
export function findEndStep(P: Float32Array, L: number, exitAt: number, a = 0.12) {
  const n = P.length;
  const pre = new Float64Array(n + 1);
  for (let r = 0; r < n; r++) pre[r + 1] = pre[r] + Math.max(-0.5, Math.min(1.5, P[r]));
  const mean = (x: number, y: number) => {
    const i0 = Math.max(0, Math.round(x));
    const i1 = Math.min(n - 1, Math.round(y));
    return i1 >= i0 ? (pre[i1 + 1] - pre[i0]) / (i1 - i0 + 1) : 0;
  };
  const A = a * L;
  let best = { r: NaN, s: -Infinity, before: 0, after: 0 };
  for (let r = Math.round(0.4 * L); r < Math.min(n, exitAt, 1.45 * L); r++) {
    const before = mean(r - A, r);
    const after = mean(r + 2, r + A);
    const s = before - after;
    if (before > 0.3 && s > best.s) best = { r, s, before, after };
  }
  return best;
}

/**
 * 沿桿身逐段追蹤：以線段平均對比在預測的橫向位置附近找桿身，
 * 以加權最小平方逐步修正直線（修正角度誤差），直到桿身不再延續。
 */
export function traceShaft(ctx: CanvasRenderingContext2D, W: number, H: number, ox: number, oy: number, thDeg: number, L: number, opt: { step?: number; win?: number; thr?: number; gap?: number; search?: number } = {}) {
  const img = ctx.getImageData(0, 0, W, H).data;
  const at = (x: number, y: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return NaN;
    const j = (yi * W + xi) * 4;
    return 0.299 * img[j] + 0.587 * img[j + 1] + 0.114 * img[j + 2];
  };
  const th = (thDeg * Math.PI) / 180;
  const dx = Math.cos(th);
  const dy = Math.sin(th);
  const nx = -dy;
  const ny = dx;
  const step = opt.step ?? 4;
  const win = opt.win ?? 6;
  const thrK = opt.thr ?? 0.4;
  const maxGap = (opt.gap ?? 0.1) * L;
  const search = opt.search ?? 3;
  const d = 3;
  // (r, e) 位置的線段平均對比（沿線 ±win）
  const seg = (r: number, e: number, slope: number) => {
    let s = 0;
    let c = 0;
    for (let t = -win; t <= win; t++) {
      const rr = r + t;
      const ee = e + slope * t;
      const x = ox + dx * rr + nx * ee;
      const y = oy + dy * rr + ny * ee;
      const v = at(x, y) - (at(x + nx * d, y + ny * d) + at(x - nx * d, y - ny * d)) / 2;
      if (!Number.isNaN(v)) {
        s += v;
        c++;
      }
    }
    return c > win ? s / c : NaN;
  };
  // 加權最小平方：e = a + b r
  let Sw = 0, Sr = 0, Se = 0, Srr = 0, Sre = 0;
  const fit = () => {
    // 先驗：通過原點附近、斜率 0（弱權重）
    const w0 = 2;
    const sw = Sw + w0, sr = Sr, se = Se, srr = Srr + w0 * (0.3 * L) ** 2, sre = Sre;
    const det = sw * srr - sr * sr;
    if (Math.abs(det) < 1e-9) return { a: 0, b: 0 };
    return { a: (se * srr - sr * sre) / det, b: (sw * sre - sr * se) / det };
  };
  const r0 = 0.18 * L;
  let ref = 0;
  const refVals: number[] = [];
  const pts: { r: number; e: number; v: number }[] = [];
  let last = NaN;
  let exitAt = Infinity;
  for (let r = r0; r <= 1.45 * L; r += step) {
    const { a, b } = fit();
    const ep = a + b * r;
    const cx = ox + dx * r + nx * ep;
    const cy = oy + dy * r + ny * ep;
    if (cx < 3 || cy < 3 || cx >= W - 3 || cy >= H - 3) {
      exitAt = r;
      break;
    }
    let best = { e: ep, v: 0 };
    for (let e = ep - search; e <= ep + search + 1e-6; e += 1) {
      const v = Math.abs(seg(r, e, b));
      if (v > best.v) best = { e, v };
    }
    if (r < 0.5 * L) {
      refVals.push(best.v);
      ref = [...refVals].sort((x, y) => x - y)[refVals.length >> 1];
    }
    const ok = r < 0.5 * L ? best.v > 0.3 * ref : best.v > thrK * ref;
    if (ok) {
      const w = Math.min(best.v / Math.max(ref, 1), 1.5);
      Sw += w;
      Sr += w * r;
      Se += w * best.e;
      Srr += w * r * r;
      Sre += w * r * best.e;
      pts.push({ r, e: best.e, v: best.v / Math.max(ref, 1) });
      last = r;
    } else if (r >= 0.5 * L && r - last > maxGap) break;
  }
  const { a, b } = fit();
  return { end: last, a, b, pts, ref, exitAt };
}

export async function traceRun(frames: number[], opt = {}, W = 540, H = 960) {
  const c = cached()!;
  const lab = new Map(c.labels.filter((l) => l.status === 'visible').map((l) => [l.frame, l]));
  const rows = [];
  for (const f of frames) {
    const l = lab.get(f);
    if (!l) continue;
    const { dbg, ctx } = await debugFrame(f, W, H);
    const s = W / 720;
    const d0 = dbg[0];
    if (!d0) continue;
    const tr = traceShaft(ctx, W, H, d0.ox, d0.oy, d0.th, d0.L, opt);
    const th = (d0.th * Math.PI) / 180;
    const pos = (r: number) => {
      const e = tr.a + tr.b * r;
      return { x: (d0.ox + Math.cos(th) * r - Math.sin(th) * e) / s, y: (d0.oy + Math.sin(th) * r + Math.cos(th) * e) / s };
    };
    const p = pos(tr.end);
    const lx = l.x! * s - d0.ox;
    const ly = l.y! * s - d0.oy;
    const along = lx * Math.cos(th) + ly * Math.sin(th);
    const lat = -lx * Math.sin(th) + ly * Math.cos(th);
    rows.push({ f, L: Math.round(d0.L), end: tr.end, trueR: Math.round(along), latTrue: Math.round(lat - (tr.a + tr.b * along)), err: Math.round(Math.hypot(p.x - l.x!, p.y - l.y!)), b: +tr.b.toFixed(3) });
  }
  return rows;
}

/** 桿頭區塊中心：在末端附近找「內圓與外環對比」最大的位置 */
export function headBlob(ctx: CanvasRenderingContext2D, W: number, H: number, ex: number, ey: number, dirx: number, diry: number, L: number, o: { rho?: number; win?: number; pen?: number } = {}) {
  const img = ctx.getImageData(0, 0, W, H).data;
  const at = (x: number, y: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return NaN;
    const j = (yi * W + xi) * 4;
    return 0.299 * img[j] + 0.587 * img[j + 1] + 0.114 * img[j + 2];
  };
  const rho = Math.max(3, (o.rho ?? 0.035) * L);
  const win = (o.win ?? 0.08) * L;
  const pen = o.pen ?? 0.3;
  const disk = (cx: number, cy: number, r0: number, r1: number) => {
    let s = 0;
    let c = 0;
    const R = Math.ceil(r1);
    for (let b = -R; b <= R; b++)
      for (let a = -R; a <= R; a++) {
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
  let best = { x: ex, y: ey, s: -Infinity };
  for (let dy = -win; dy <= win; dy += 1)
    for (let dx = -win; dx <= win; dx += 1) {
      if (Math.hypot(dx, dy) > win) continue;
      // 不往桿身方向回頭太多
      if (dx * dirx + dy * diry < -0.3 * win) continue;
      const cx = ex + dx;
      const cy = ey + dy;
      const v = Math.abs(disk(cx, cy, 0, rho) - disk(cx, cy, rho * 1.5, rho * 2.3));
      const sc = v - pen * Math.hypot(dx, dy);
      if (sc > best.s) best = { x: cx, y: cy, s: sc };
    }
  return best;
}

export async function blobRun(frames: number[], o = {}, W = 540, H = 960) {
  const c = cached()!;
  const lab = new Map(c.labels.filter((l) => l.status === 'visible').map((l) => [l.frame, l]));
  const rows = [];
  for (const f of frames) {
    const l = lab.get(f);
    if (!l) continue;
    const { dbg, ctx } = await debugFrame(f, W, H);
    const s = W / 720;
    const d0 = dbg[0] as unknown as { th: number; ox: number; oy: number; L: number; tr: { end: number; outOfFrame: boolean; point: (r: number) => { x: number; y: number } } };
    if (!d0 || !Number.isFinite(d0.tr.end)) continue;
    const e = d0.tr.point(d0.tr.end);
    const th = (d0.th * Math.PI) / 180;
    const b = headBlob(ctx, W, H, e.x, e.y, Math.cos(th), Math.sin(th), d0.L, o);
    rows.push({ f, oof: d0.tr.outOfFrame, endErr: Math.round(Math.hypot(e.x / s - l.x!, e.y / s - l.y!)), blobErr: Math.round(Math.hypot(b.x / s - l.x!, b.y / s - l.y!)) });
  }
  return rows;
}

export async function protoRun(frames: number[], W = 540, H = 960, a = 0.12, headOff = 0) {
  const c = cached()!;
  const lab = new Map(c.labels.filter((l) => l.status === 'visible').map((l) => [l.frame, l]));
  const rows = [];
  for (const f of frames) {
    const l = lab.get(f);
    if (!l) continue;
    const { dbg, ctx } = await debugFrame(f, W, H);
    const s = W / 720;
    const res = dbg.map((d) => {
      const pr = lineProfile(ctx, W, H, d.ox, d.oy, d.th, d.L);
      const e = findEndStep(pr.P, d.L, pr.exitAt, a);
      const rr = e.r + headOff * d.L;
      const x = (d.ox + Math.cos((d.th * Math.PI) / 180) * rr) / s;
      const y = (d.oy + Math.sin((d.th * Math.PI) / 180) * rr) / s;
      // 標記在此線上的投影
      const lx = l.x! * s - d.ox;
      const ly = l.y! * s - d.oy;
      const along = lx * Math.cos((d.th * Math.PI) / 180) + ly * Math.sin((d.th * Math.PI) / 180);
      return { th: +d.th.toFixed(1), end: Math.round(e.r), trueR: Math.round(along), sc: +e.s.toFixed(2), bef: +e.before.toFixed(2), aft: +e.after.toFixed(2), err: Math.round(Math.hypot(x - l.x!, y - l.y!)) };
    });
    rows.push({ f, res });
  }
  return rows;
}

if (import.meta.hot) import.meta.hot.accept();
