import type { AnalysisResult } from '../core/pipeline';
import type { CaptureInfo, FrameData } from '../types';
import { LAYERS } from './layers';
import type { LayerId, LayerStyle } from './types';

export type LayerSettings = Record<LayerId, LayerStyle>;
export type TrailMode = 'toNow' | 'full';

export interface ContentRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 計算 object-fit: contain 後影像在容器中的位置 */
export function containRect(boxW: number, boxH: number, W: number, H: number): ContentRect {
  const s = Math.min(boxW / W, boxH / H);
  const w = W * s;
  const h = H * s;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

export interface RenderInput {
  canvas: HTMLCanvasElement;
  fd: FrameData;
  frame: number;
  W: number;
  H: number;
  result: AnalysisResult;
  capture: CaptureInfo;
  layers: LayerSettings;
  trailMode: TrailMode;
  /** 使用者縮放平移 */
  zoom: { k: number; x: number; y: number };
  t: (key: string) => string;
  /** 離屏繪製（匯出）時指定尺寸，否則取 canvas 的 CSS 尺寸 */
  size?: { w: number; h: number; dpr: number };
}

export function defaultLayerSettings(): LayerSettings {
  return Object.fromEntries(LAYERS.map((l) => [l.id, { enabled: l.defaultOn, ...l.defaultStyle }])) as LayerSettings;
}

export const PRESETS: Record<string, LayerId[]> = {
  beginner: ['skeleton', 'clubPath', 'clubShaft', 'phaseMarkers'],
  plane: ['swingPlane', 'clubPath', 'clubShaft', 'handPath', 'phaseMarkers'],
  body: ['skeleton', 'spineAngle', 'hipPath', 'headPath', 'rotationGauge'],
  all: LAYERS.map((l) => l.id).filter((id) => id !== 'grid'),
};

export function renderOverlay(inp: RenderInput) {
  const { canvas, fd, W, H } = inp;
  const dpr = inp.size?.dpr ?? (window.devicePixelRatio || 1);
  const cssW = inp.size?.w ?? canvas.clientWidth;
  const cssH = inp.size?.h ?? canvas.clientHeight;
  const ctx = canvas.getContext('2d')!;
  if (!inp.size) {
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  if (!fd.n) return;

  const rect = containRect(cssW, cssH, W, H);
  const scale = (rect.w / W) * inp.zoom.k;
  const frame = Math.max(0, Math.min(fd.n - 1, inp.frame));
  const from = 0;
  const to = inp.trailMode === 'full' ? fd.n - 1 : frame;

  for (const layer of LAYERS) {
    const style = inp.layers[layer.id];
    if (!style?.enabled || !layer.views.includes(inp.capture.viewAngle)) continue;
    ctx.save();
    if (layer.screenSpace) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    } else {
      ctx.setTransform(
        dpr * scale,
        0,
        0,
        dpr * scale,
        dpr * (rect.x * inp.zoom.k + inp.zoom.x),
        dpr * (rect.y * inp.zoom.k + inp.zoom.y),
      );
    }
    try {
      layer.draw({
        ctx,
        fd,
        frame,
        W,
        H,
        scale,
        px: (v) => v / scale,
        result: inp.result,
        capture: inp.capture,
        style,
        from,
        to,
        t: inp.t,
      });
    } catch (e) {
      console.warn(`[overlay] ${layer.id}`, e);
    }
    ctx.restore();
  }
}

/** 將畫面座標（CSS px，相對 canvas）轉為 0..1 的影片座標 */
export function screenToVideo(cx: number, cy: number, canvas: HTMLCanvasElement, W: number, H: number, zoom: { k: number; x: number; y: number }) {
  const rect = containRect(canvas.clientWidth, canvas.clientHeight, W, H);
  const x = (cx - zoom.x) / zoom.k;
  const y = (cy - zoom.y) / zoom.k;
  return { x: (x - rect.x) / rect.w, y: (y - rect.y) / rect.h };
}
