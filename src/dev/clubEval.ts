/**
 * 開發用：以人工標記評估桿頭追蹤準確度（不會被網站引用、不會打包）。
 * 影片與標記放在 00_data/（不進版控）。在開發伺服器的瀏覽器主控台執行：
 *   const m = await import('/src/dev/clubEval.ts'); await m.runAll();
 * 只改追蹤器時不必重跑推論：await m.restoreAll(); m.evaluateAll();
 */
import { runInference } from '../core/inference/runInference';
import { probeVideo } from '../core/video/probe';
import { LM, dist, handsCenter, lm, mid, shoulderCenter } from '../core/landmarks';
import { analyze } from '../core/pipeline';
import { smoothPose } from '../core/tracking/poseSmoothing';
import type { CaptureInfo, FrameData, VideoMeta } from '../types';

export interface EvalLabel {
  frame: number;
  status: string;
  x: number | null;
  y: number | null;
  phase?: string | null;
}

export interface EvalRow {
  f: number;
  err: number;
  angleErr: number;
  rTrue: number;
  rPred: number;
  src: number;
  seg: Seg;
}

type Seg = 'static' | 'back' | 'down' | 'follow';

/** 評估與訓練資料用的影片（放在 00_data/，不進版控） */
export const VIDEOS: { name: string; duration: number; w: number; h: number; fps: number; ext?: string }[] = [
  { name: '811257859.281721', duration: 9.305, w: 720, h: 1280, fps: 30 },
  { name: '811526255.326530', duration: 7.103, w: 720, h: 1280, fps: 30 },
  { name: '811526255.419161', duration: 7.337, w: 720, h: 1280, fps: 30 },
  { name: '811526255.595193', duration: 4.902, w: 720, h: 1280, fps: 30 },
  { name: '811526255.666065', duration: 8.008, w: 720, h: 1280, fps: 30 },
  { name: '811526255.728889', duration: 6.137, w: 720, h: 1280, fps: 30 },
  { name: '811526255.783496', duration: 5.603, w: 720, h: 1280, fps: 30 },
  { name: '14431eda-3323-4807-8622-4144495ddb99', duration: 11.147, w: 720, h: 1280, fps: 30 },
  { name: '3e09cec1-ed23-4817-883a-1ec41ac91676', duration: 7.882, w: 720, h: 1280, fps: 30 },
  { name: 'a4213018-bfe9-4f61-b829-3c4f8f773d3f', duration: 12.213, w: 720, h: 1280, fps: 30 },
  { name: 'cc8b1160-dff6-4123-b59b-1d702fa35b95', duration: 12.147, w: 720, h: 1280, fps: 30 },
  { name: 'e58d6484-4ffd-4e2e-8ee9-cbdf5739a390', duration: 10.413, w: 720, h: 1280, fps: 30 },
  { name: '2a74f953-c603-434e-ae55-bc26327785fd', duration: 5.103, w: 2160, h: 3840, fps: 60 },
  { name: '33316944-f3a0-4776-9467-2c020f684993', duration: 7.438, w: 2160, h: 3840, fps: 60 },
  { name: '6582dbce-84f2-42b2-bbc0-a819728f9a56', duration: 4.387, w: 2160, h: 3840, fps: 60 },
  { name: '20260920_164245', duration: 5.767, w: 1080, h: 1920, fps: 60, ext: 'MP4' },
  { name: '20260920_164303', duration: 6.833, w: 1080, h: 1920, fps: 60, ext: 'MP4' },
  { name: 'IMG_6974', duration: 3.852, w: 2160, h: 3840, fps: 60, ext: 'MOV' },
  { name: 'IMG_6975', duration: 4.419, w: 1080, h: 1920, fps: 120, ext: 'MOV' },
  { name: 'IMG_6978', duration: 5.303, w: 1080, h: 1920, fps: 120, ext: 'MOV' },
];
// 實際尺寸以 probeVideo 為準（旋轉後），推論過一次就會記錄下來
const sizes = new Map<string, { W: number; H: number }>();
const sizeOf = (name: string) => {
  const s = sizes.get(name);
  if (s) return s;
  const v = VIDEOS.find((x) => x.name === name)!;
  return { W: v.w, H: v.h };
};

// 存在 globalThis：模組因 HMR 重新載入時仍保留推論結果
const G = globalThis as { __clubEvalCache?: Map<string, FrameData> };
const cache: Map<string, FrameData> = (G.__clubEvalCache ??= new Map());
const labelCache = new Map<string, EvalLabel[] | null>();

async function labelsOf(name: string): Promise<EvalLabel[] | null> {
  if (labelCache.has(name)) return labelCache.get(name)!;
  const r = await fetch(`/00_data/labels/${name}_clubhead_labels.json`);
  const v = r.ok && (r.headers.get('content-type') ?? '').includes('json') ? ((await r.json()).labels as EvalLabel[]) : null;
  labelCache.set(name, v);
  return v;
}

/** 重跑完整推論（偵測器有改動時用），結果快取並存進 IndexedDB */
export async function infer(name: string): Promise<FrameData> {
  const v = VIDEOS.find((x) => x.name === name)!;
  const file = await (await fetch(`/00_data/${name}.${v.ext ?? 'mp4'}`)).blob();
  // 與 App 相同：由檔案本身取得尺寸、影格率與旋轉角（iPhone 影片常帶 90° 旋轉）
  const p = await probeVideo(file);
  const video: VideoMeta = {
    storageKey: 'eval',
    fileName: `${name}.${v.ext ?? 'mp4'}`,
    mimeType: v.ext === 'MOV' ? 'video/quicktime' : 'video/mp4',
    durationSec: p.durationSec || v.duration,
    fps: Math.round(p.fps) || v.fps,
    width: p.width,
    height: p.height,
    rotation: p.rotation,
    slowMoFactor: 1,
    trimStart: 0,
    trimEnd: p.durationSec || v.duration,
  };
  sizes.set(name, { W: p.width, H: p.height });
  const out = await runInference(file, video, { poseModel: 'full', stride: 1, maxSide: 960, onProgress: () => undefined });
  smoothPose(out.frames);
  cache.set(name, out.frames);
  await idbPut(name, out.frames);
  return out.frames;
}

const capture: CaptureInfo = { viewAngle: 'dtl', handedness: 'right', heightCm: 165, clubType: 'iron', clubLengthCm: 94 };

/** 各段起點：標記檔中的 takeaway / top / impact 格 */
function segOf(labels: EvalLabel[], f: number): Seg {
  const at = (p: string) => labels.find((l) => l.phase === p)?.frame ?? Infinity;
  if (f < at('takeaway')) return 'static';
  if (f <= at('top')) return 'back';
  if (f <= at('impact')) return 'down';
  return 'follow';
}

/** 以快取的推論結果重新追蹤，與標記比較 */
export async function evaluate(name: string) {
  const fd = cache.get(name);
  const labels = await labelsOf(name);
  if (!fd || !labels) return null;
  const { W, H } = sizeOf(name);
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
    rows.push({ f, err: Math.hypot(px - l.x, py - l.y), angleErr: dA, rTrue: Math.hypot(l.x - h.x, l.y - h.y), rPred: Math.hypot(px - h.x, py - h.y), src: fd.clubSource[f], seg: segOf(labels, f) });
  }
  return rows;
}

/** 平均 / 中位數 / 90 百分位（px，720×1280） */
export function stat(e: number[]) {
  if (!e.length) return '-';
  const s = [...e].sort((x, y) => x - y);
  const mean = s.reduce((x, y) => x + y, 0) / s.length;
  return `${mean.toFixed(0)}/${s[s.length >> 1].toFixed(0)}/${s[Math.floor(s.length * 0.9)].toFixed(0)}`;
}

export function summarize(rows: EvalRow[]) {
  const by = (seg: Seg) => stat(rows.filter((r) => r.seg === seg).map((r) => r.err));
  const swing = rows.filter((r) => r.seg !== 'static').map((r) => r.err);
  return { n: rows.length, static: by('static'), back: by('back'), down: by('down'), follow: by('follow'), swing: stat(swing), all: stat(rows.map((r) => r.err)) };
}

/** 所有已快取且有標記的影片 */
export async function evaluateAll() {
  const out: Record<string, ReturnType<typeof summarize>> = {};
  const pooled: EvalRow[] = [];
  for (const v of VIDEOS) {
    const rows = await evaluate(v.name);
    if (!rows) continue;
    out[v.name] = summarize(rows);
    pooled.push(...rows);
  }
  out.ALL = summarize(pooled);
  return out;
}

export async function runAll(names = VIDEOS.map((v) => v.name)) {
  const t0 = performance.now();
  for (const n of names) {
    await infer(n);
    await savePred(n);
  }
  return { sec: Math.round((performance.now() - t0) / 1000), ...(await evaluateAll()) };
}

/** 追蹤結果與雙手位置存到 00_data/eval/<name>_pred.json（給標記工具用） */
export async function savePred(name: string) {
  const fd = cache.get(name);
  if (!fd) return;
  const { W, H } = sizeOf(name);
  analyze(fd, capture, W, H);
  const r = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
  const frames = [];
  for (let f = 0; f < fd.n; f++) {
    const h = handsCenter(fd, f, W, H);
    // 軀幹長度：App 以「雙手為中心、邊長 5.5 倍軀幹」的正方形送進模型，產生訓練圖時要一致
    const torso = dist(shoulderCenter(fd, f, W, H), mid(lm(fd, f, LM.leftHip, W, H), lm(fd, f, LM.rightHip, W, H)));
    const x = fd.club[f * 2] * W;
    const y = fd.club[f * 2 + 1] * H;
    frames.push({ f, t: r(fd.t[f]), x: r(x), y: r(y), src: fd.clubSource[f], hx: r(h.x), hy: r(h.y), r: r(Math.hypot(x - h.x, y - h.y)), torso: r(torso) });
  }
  await fetch(`/__dev/save?name=${name}_pred.json`, { method: 'POST', body: JSON.stringify({ name, W, H, frames }) });
}

// ---- IndexedDB：頁面重新載入後用 restoreAll() 取回推論結果 ----
function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open('clubEvalDev', 2);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbPut(key: string, v: unknown) {
  const db = await idb();
  await new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(v, key);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
export async function restoreAll() {
  const db = await idb();
  for (const v of VIDEOS) {
    const fd = await new Promise<FrameData | undefined>((res, rej) => {
      const r = db.transaction('kv').objectStore('kv').get(v.name);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    if (fd) cache.set(v.name, fd);
  }
  return [...cache.keys()];
}

export function cached(name: string) {
  return cache.get(name) ?? null;
}

if (import.meta.hot) import.meta.hot.accept();
