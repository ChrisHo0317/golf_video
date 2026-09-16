import type { InferenceSession, Tensor } from 'onnxruntime-web';

export interface ClubModelMeta {
  version: string;
  inputSize: number;
  classNames: string[];
  clubClass: number;
}

export interface ClubDetection {
  /** 分析畫布上的像素座標 */
  x: number;
  y: number;
  conf: number;
}

export interface Roi {
  x: number;
  y: number;
  size: number;
}

type Ort = typeof import('onnxruntime-web/webgpu');

/** 桿頭偵測（YOLO ONNX）。模型不存在時 load() 回傳 null */
export class ClubDetector {
  private constructor(
    private ort: Ort,
    private session: InferenceSession,
    readonly meta: ClubModelMeta,
    private ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  ) {}

  static async load(): Promise<ClubDetector | null> {
    const base = import.meta.env.BASE_URL;
    let meta: ClubModelMeta;
    try {
      const r = await fetch(`${base}models/clubhead.json`);
      if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return null;
      meta = await r.json();
    } catch {
      return null;
    }
    const ort: Ort = await import('onnxruntime-web/webgpu');
    ort.env.wasm.wasmPaths = `${base}wasm/ort/`;
    ort.env.wasm.numThreads = 1;
    const url = `${base}models/clubhead.onnx`;
    const providers: string[] = [];
    if ('gpu' in navigator) providers.push('webgpu');
    providers.push('wasm');
    let session: InferenceSession | null = null;
    for (const ep of providers) {
      try {
        session = await ort.InferenceSession.create(url, { executionProviders: [ep], graphOptimizationLevel: 'all' });
        break;
      } catch (e) {
        console.warn(`[club] ${ep} failed`, e);
      }
    }
    if (!session) return null;
    const s = meta.inputSize;
    let canvas: OffscreenCanvas | HTMLCanvasElement;
    if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(s, s);
    else {
      canvas = document.createElement('canvas');
      canvas.width = canvas.height = s;
    }
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
    return new ClubDetector(ort, session, meta, ctx);
  }

  /** 在 ROI（正方形）內偵測，回傳信心值最高的前幾個候選 */
  async detect(src: OffscreenCanvas | HTMLCanvasElement, roi: Roi | null, topK = 3): Promise<ClubDetection[]> {
    const S = this.meta.inputSize;
    const r = roi ?? { x: 0, y: 0, size: Math.max(src.width, src.height) };
    const scale = S / r.size;
    const ctx = this.ctx;
    ctx.fillStyle = 'rgb(114,114,114)';
    ctx.fillRect(0, 0, S, S);
    ctx.drawImage(src, r.x, r.y, r.size, r.size, 0, 0, S, S);
    const { data } = ctx.getImageData(0, 0, S, S);
    const plane = S * S;
    const input = new Float32Array(plane * 3);
    for (let i = 0; i < plane; i++) {
      input[i] = data[i * 4] / 255;
      input[i + plane] = data[i * 4 + 1] / 255;
      input[i + plane * 2] = data[i * 4 + 2] / 255;
    }
    const tensor = new this.ort.Tensor('float32', input, [1, 3, S, S]);
    const feeds: Record<string, Tensor> = { [this.session.inputNames[0]]: tensor };
    const out = await this.session.run(feeds);
    const o = out[this.session.outputNames[0]];
    const res = parseYolo(o.data as Float32Array, o.dims as number[], this.meta.clubClass, 0.15);
    tensor.dispose?.();
    o.dispose?.();
    return nms(res, 0.02 * S)
      .slice(0, topK)
      .map((d) => ({ x: r.x + d.x / scale, y: r.y + d.y / scale, conf: d.conf }));
  }
}

/** YOLOv8/11 輸出：[1, 4 + nc, N]，每欄為 cx, cy, w, h, class scores */
export function parseYolo(data: Float32Array, dims: number[], cls: number, minConf: number) {
  const N = dims[2];
  const out: { x: number; y: number; conf: number }[] = [];
  for (let i = 0; i < N; i++) {
    const conf = data[(4 + cls) * N + i];
    if (conf < minConf) continue;
    out.push({ x: data[i], y: data[N + i], conf });
  }
  return out.sort((a, b) => b.conf - a.conf);
}

function nms(dets: { x: number; y: number; conf: number }[], radius: number) {
  const kept: typeof dets = [];
  for (const d of dets) {
    if (kept.every((k) => Math.hypot(k.x - d.x, k.y - d.y) > radius)) kept.push(d);
  }
  return kept;
}
