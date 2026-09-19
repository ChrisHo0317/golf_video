/**
 * 開發用：以人工標記評估桿頭追蹤準確度（不會被網站引用、不會打包）。
 * 在開發伺服器的瀏覽器主控台執行：
 *   const m = await import('/src/dev/clubEval.ts'); await m.runClubEval();
 */
import { runInference } from '../core/inference/runInference';
import { handsCenter } from '../core/landmarks';
import { analyze } from '../core/pipeline';
import { smoothPose } from '../core/tracking/poseSmoothing';
import type { CaptureInfo, FrameData, VideoMeta } from '../types';

export interface EvalLabel {
  frame: number;
  status: string;
  x: number | null;
  y: number | null;
}

export interface EvalRow {
  f: number;
  err: number;
  angleErr: number;
  rTrue: number;
  rPred: number;
  src: number;
}

const VIDEO = '/00_data/811257859.281721.mp4';
const LABELS = '/00_data/labels/811257859.281721_clubhead_labels.json';
const W = 720;
const H = 1280;

// 存在 globalThis：模組因 HMR 重新載入時仍保留推論結果
const G = globalThis as { __clubEvalCache?: { fd: FrameData; labels: EvalLabel[] } | null };
let cache = G.__clubEvalCache ?? null;

/** 重跑完整推論（偵測器有改動時用）；結果快取，只改追蹤器時可用 retrack() */
export async function infer(): Promise<FrameData> {
  const labels = (await (await fetch(LABELS)).json()).labels as EvalLabel[];
  const file = await (await fetch(VIDEO)).blob();
  const video: VideoMeta = {
    storageKey: 'eval',
    fileName: 'eval.mp4',
    mimeType: 'video/mp4',
    durationSec: 9.305,
    fps: 30,
    width: W,
    height: H,
    rotation: 0,
    slowMoFactor: 1,
    trimStart: 0,
    trimEnd: 9.305,
  };
  const out = await runInference(file, video, { poseModel: 'full', stride: 1, maxSide: 960, onProgress: () => undefined });
  smoothPose(out.frames);
  cache = G.__clubEvalCache = { fd: out.frames, labels };
  return out.frames;
}

const capture: CaptureInfo = { viewAngle: 'dtl', handedness: 'right', heightCm: 165, clubType: 'iron', clubLengthCm: 94 };

/** 以目前快取的推論結果重新追蹤並評估 */
export function evaluate(fd: FrameData = cached()!.fd, labels: EvalLabel[] = cached()!.labels) {
  analyze(fd, capture, W, H);
  const rows: EvalRow[] = [];
  for (const l of labels) {
    if (l.status !== 'visible' || l.x == null || l.y == null) continue;
    const f = l.frame;
    const px = fd.club[f * 2] * W;
    const py = fd.club[f * 2 + 1] * H;
    const h = handsCenter(fd, f, W, H);
    const aT = Math.atan2(l.y - h.y, l.x - h.x);
    const aP = Math.atan2(py - h.y, px - h.x);
    const dA = ((((aP - aT) * 180) / Math.PI + 540) % 360) - 180;
    rows.push({ f, err: Math.hypot(px - l.x, py - l.y), angleErr: dA, rTrue: Math.hypot(l.x - h.x, l.y - h.y), rPred: Math.hypot(px - h.x, py - h.y), src: fd.clubSource[f] });
  }
  const seg = (a: number, b: number) => {
    const e = rows.filter((r) => r.f >= a && r.f <= b).map((r) => r.err).sort((x, y) => x - y);
    const mean = e.reduce((x, y) => x + y, 0) / e.length;
    return `${mean.toFixed(0)}/${e[e.length >> 1].toFixed(0)}/${e[Math.floor(e.length * 0.9)].toFixed(0)}`;
  };
  return {
    rows,
    summary: { address: seg(0, 199), back: seg(200, 219), down: seg(220, 232), follow: seg(233, 278), swing: seg(200, 278), all: seg(0, 278) },
  };
}

export async function runClubEval() {
  const t0 = performance.now();
  await infer();
  await persist();
  const r = evaluate();
  return { sec: Math.round((performance.now() - t0) / 1000), ...r.summary };
}

export function cached() {
  return cache ?? G.__clubEvalCache ?? null;
}

// 推論結果存進 IndexedDB：頁面重新載入後用 restore() 取回，不必重跑推論
function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open('clubEvalDev', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function persist() {
  const c = cached();
  if (!c) return;
  const db = await idb();
  await new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(c, 'last');
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
export async function restore() {
  const db = await idb();
  const v = await new Promise<{ fd: FrameData; labels: EvalLabel[] } | undefined>((res, rej) => {
    const r = db.transaction('kv').objectStore('kv').get('last');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  if (v) cache = G.__clubEvalCache = v;
  return !!v;
}

if (import.meta.hot) import.meta.hot.accept();
