import type { AnalysisResult } from '../core/pipeline';
import type { CaptureInfo, FrameData } from '../types';
import { loadVideo, seekVideo } from '../core/video/videoElement';
import { renderOverlay, type LayerSettings, type TrailMode } from './renderer';

/** 在已排序的媒體時間陣列中找最接近的格 */
export function nearestFrame(mediaT: Float64Array, time: number): number {
  let lo = 0;
  let hi = mediaT.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (mediaT[m] < time) lo = m + 1;
    else hi = m;
  }
  if (lo > 0 && Math.abs(mediaT[lo - 1] - time) < Math.abs(mediaT[lo] - time)) return lo - 1;
  return lo;
}

function pickMime(): string {
  const cands = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  return cands.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

export interface ExportVideoInput {
  blob: Blob;
  fd: FrameData;
  W: number;
  H: number;
  result: AnalysisResult;
  capture: CaptureInfo;
  layers: LayerSettings;
  trailMode: TrailMode;
  t: (k: string) => string;
  onProgress: (p: number) => void;
}

/** 以 MediaRecorder 錄製「影片 + 疊加圖層」 */
export async function exportAnnotatedVideo(inp: ExportVideoInput): Promise<{ blob: Blob; ext: string }> {
  const { fd, W, H } = inp;
  const s = Math.min(1, 1080 / Math.max(W, H));
  const cw = Math.round((W * s) / 2) * 2;
  const ch = Math.round((H * s) / 2) * 2;
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d')!;

  const { video: v, dispose } = await loadVideo(inp.blob);

  const start = fd.mediaT[0];
  const end = fd.mediaT[fd.n - 1];
  await seekVideo(v, start);

  const mime = pickMime();
  const stream = canvas.captureStream(60);
  const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise<void>((r) => (rec.onstop = () => r()));

  const draw = (mediaTime: number) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(v, 0, 0, cw, ch);
    renderOverlay({
      canvas,
      fd,
      frame: nearestFrame(fd.mediaT, mediaTime),
      W,
      H,
      result: inp.result,
      capture: inp.capture,
      layers: inp.layers,
      trailMode: inp.trailMode,
      zoom: { k: 1, x: 0, y: 0 },
      t: inp.t,
      size: { w: cw, h: ch, dpr: 1 },
    });
    inp.onProgress(Math.min(1, (mediaTime - start) / Math.max(end - start, 1e-6)));
  };

  draw(start);
  rec.start(250);
  await new Promise<void>((resolve) => {
    const finish = () => {
      v.pause();
      resolve();
    };
    const hasRvfc = typeof (v as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback === 'function';
    if (hasRvfc) {
      const cb = (_now: number, meta: VideoFrameCallbackMetadata) => {
        draw(meta.mediaTime);
        if (meta.mediaTime >= end || v.ended) finish();
        else v.requestVideoFrameCallback(cb);
      };
      v.requestVideoFrameCallback(cb);
    } else {
      const loop = () => {
        draw(v.currentTime);
        if (v.currentTime >= end || v.ended) finish();
        else requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }
    v.onended = finish;
    void v.play();
  });
  rec.stop();
  await stopped;
  dispose();
  const type = rec.mimeType || mime || 'video/webm';
  return { blob: new Blob(chunks, { type }), ext: type.includes('mp4') ? 'mp4' : 'webm' };
}
