import { frameSource, type FrameSourceOptions } from './frameSource';

export interface Background {
  /** 灰階中位數影像（縮小 scale 倍） */
  gray: Float32Array;
  w: number;
  h: number;
  /** 分析畫布座標 × scale = 背景座標 */
  scale: number;
}

const SAMPLES = 21;

/**
 * 取樣整段影片，以逐像素中位數建立靜態背景。
 * 用來辨識「固定不動的背景直線」（地平線、網柱、地墊邊緣），避免誤判為桿身。
 */
export async function buildBackground(file: Blob, opt: Omit<FrameSourceOptions, 'stride'>, totalFrames: number, scale = 0.5): Promise<Background | null> {
  const stride = Math.max(1, Math.floor(totalFrames / SAMPLES));
  const stack: Uint8Array[] = [];
  let w = 0;
  let h = 0;
  let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
  for await (const fr of frameSource(file, { ...opt, stride })) {
    if (!ctx) {
      w = Math.round(fr.canvas.width * scale);
      h = Math.round(fr.canvas.height * scale);
      if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(w, h);
      else {
        canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
      }
      ctx = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
    }
    ctx.drawImage(fr.canvas, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const g = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) | 0;
    stack.push(g);
    if (stack.length >= SAMPLES) break;
  }
  if (stack.length < 5) return null;

  // 逐像素中位數（以 256 格直方圖計算，避免排序）
  const m = stack.length;
  const half = m >> 1;
  const gray = new Float32Array(w * h);
  const hist = new Uint16Array(256);
  for (let i = 0; i < w * h; i++) {
    hist.fill(0);
    for (let k = 0; k < m; k++) hist[stack[k][i]]++;
    let acc = 0;
    let v = 0;
    for (; v < 256; v++) {
      acc += hist[v];
      if (acc > half) break;
    }
    gray[i] = v;
  }
  return { gray, w, h, scale };
}
