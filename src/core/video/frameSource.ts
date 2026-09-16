import { DataStream, Endianness, type Sample } from 'mp4box';
import { demux } from './probe';

export interface FrameSourceOptions {
  start: number;
  end: number;
  rotation: 0 | 90 | 180 | 270;
  /** 分析用影像長邊上限 */
  maxSide: number;
  /** 降級路徑的取樣 FPS */
  fallbackFps: number;
  /** 每 N 格取 1 格 */
  stride: number;
  signal?: AbortSignal;
}

export interface AnalysisFrame {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  /** 媒體時間（秒） */
  mediaTime: number;
  /** 預估總格數（進度用） */
  total: number;
}

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function makeCanvas(w: number, h: number): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: Canvas2D } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true })! };
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true })! };
}

/** 將來源影像依旋轉角繪入分析畫布 */
function drawRotated(ctx: Canvas2D, src: CanvasImageSource, sw: number, sh: number, rotation: number, outW: number, outH: number) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  const swap = rotation === 90 || rotation === 270;
  const dw = swap ? outH : outW;
  const dh = swap ? outW : outH;
  ctx.drawImage(src, 0, 0, sw, sh, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

function fitSize(w: number, h: number, maxSide: number) {
  const s = Math.min(1, maxSide / Math.max(w, h));
  return { w: Math.round(w * s), h: Math.round(h * s) };
}

export function canUseWebCodecs(): boolean {
  return typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';
}

/** 逐格產生分析影像：優先 WebCodecs，失敗時改用 <video> seek */
export async function* frameSource(file: Blob, opt: FrameSourceOptions): AsyncGenerator<AnalysisFrame> {
  if (canUseWebCodecs()) {
    const gen = await tryWebCodecs(file, opt);
    if (gen) {
      yield* gen;
      return;
    }
  }
  yield* seekFrames(file, opt);
}

async function tryWebCodecs(file: Blob, opt: FrameSourceOptions): Promise<AsyncGenerator<AnalysisFrame> | null> {
  const d = await demux(file, true).catch(() => null);
  const track = d?.info.videoTracks[0];
  if (!d || !track) return null;
  const trak = d.iso.getTrackById(track.id);
  const entry = trak.mdia.minf.stbl.stsd.entries[0] as unknown as Record<string, { write(s: DataStream): void } | undefined>;
  const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
  let description: Uint8Array | undefined;
  if (box) {
    const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
    box.write(stream);
    description = new Uint8Array((stream as unknown as { buffer: ArrayBuffer }).buffer, 8);
  }
  const config: VideoDecoderConfig = {
    codec: track.codec.startsWith('vp08') ? 'vp8' : track.codec,
    codedWidth: track.video?.width ?? track.track_width,
    codedHeight: track.video?.height ?? track.track_height,
    description,
    hardwareAcceleration: 'no-preference',
  };
  const support = await VideoDecoder.isConfigSupported(config).catch(() => null);
  if (!support?.supported) return null;

  // 取出所有樣本
  const samples: Sample[] = [];
  d.iso.onSamples = (_id, _user, s) => {
    for (const x of s) samples.push(x);
  };
  d.iso.setExtractionOptions(track.id, null, { nbSamples: Number.MAX_SAFE_INTEGER });
  d.iso.start();
  d.iso.flush();
  if (!samples.length) return null;
  return decodeSamples(samples, config, opt);
}

async function* decodeSamples(samples: Sample[], config: VideoDecoderConfig, opt: FrameSourceOptions): AsyncGenerator<AnalysisFrame> {
  const ts = samples[0].timescale;
  const minCts = Math.min(...samples.map((s) => s.cts));
  const timeOf = (cts: number) => (cts - minCts) / ts;

  // 從起點前最近的關鍵格開始解碼
  let first = 0;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].is_sync && timeOf(samples[i].cts) <= opt.start + 1e-4) first = i;
  }
  const inRange = samples.filter((s) => {
    const tt = timeOf(s.cts);
    return tt >= opt.start - 1e-4 && tt <= opt.end + 1e-4;
  }).length;
  const total = Math.ceil(inRange / opt.stride);

  const queue: VideoFrame[] = [];
  let error: unknown = null;
  let wake: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  const decoder = new VideoDecoder({
    output: (f) => {
      queue.push(f);
      notify();
    },
    error: (e) => {
      error = e;
      notify();
    },
  });
  decoder.addEventListener('dequeue', notify);
  decoder.configure(config);
  const waitEvent = () => new Promise<void>((r) => (wake = r));

  let out: ReturnType<typeof makeCanvas> | null = null;
  let size = { w: 0, h: 0 };
  let emitted = 0;
  let seen = 0;

  const emit = function* (frame: VideoFrame): Generator<AnalysisFrame> {
    const tt = (frame.timestamp ?? 0) / 1e6;
    try {
      if (tt < opt.start - 1e-4 || tt > opt.end + 1e-4) return;
      if (seen++ % opt.stride !== 0) return;
      if (!out) {
        const swap = opt.rotation === 90 || opt.rotation === 270;
        size = fitSize(swap ? frame.displayHeight : frame.displayWidth, swap ? frame.displayWidth : frame.displayHeight, opt.maxSide);
        out = makeCanvas(size.w, size.h);
      }
      drawRotated(out.ctx, frame, frame.displayWidth, frame.displayHeight, opt.rotation, size.w, size.h);
    } finally {
      frame.close();
    }
    emitted++;
    yield { canvas: out!.canvas, mediaTime: tt, total };
  };

  try {
    for (let i = first; i < samples.length; i++) {
      if (opt.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const s = samples[i];
      if (timeOf(s.dts) > opt.end + 1) break;
      decoder.decode(
        new EncodedVideoChunk({
          type: s.is_sync ? 'key' : 'delta',
          timestamp: Math.round(timeOf(s.cts) * 1e6),
          duration: Math.round((s.duration / ts) * 1e6),
          data: s.data!,
        }),
      );
      s.data = undefined; // 釋放記憶體
      while (queue.length) yield* emit(queue.shift()!);
      // 解碼器的輸出影格有數量上限：必須先釋放佇列中的影格，佇列空了才等待，否則會互相卡住
      while (decoder.decodeQueueSize > 4 && !error) {
        if (queue.length) yield* emit(queue.shift()!);
        else await waitEvent();
      }
      if (error) throw error;
    }
    // flush 期間持續消化輸出，否則未釋放的影格會讓 flush 永遠無法完成
    let flushed = false;
    decoder.flush().then(
      () => {
        flushed = true;
        notify();
      },
      (e) => {
        error ??= e;
        flushed = true;
        notify();
      },
    );
    while (!flushed || queue.length) {
      if (queue.length) yield* emit(queue.shift()!);
      else await waitEvent();
    }
    if (error) throw error;
    if (!emitted) throw new Error('no-frames');
  } finally {
    for (const f of queue) f.close();
    if (decoder.state !== 'closed') decoder.close();
  }
}

async function* seekFrames(file: Blob, opt: FrameSourceOptions): AsyncGenerator<AnalysisFrame> {
  const v = document.createElement('video');
  const url = URL.createObjectURL(file);
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = url;
  try {
    await new Promise<void>((res, rej) => {
      v.onloadeddata = () => res();
      v.onerror = () => rej(new Error('unsupported-video'));
    });
    const { w, h } = fitSize(v.videoWidth, v.videoHeight, opt.maxSide);
    const { canvas, ctx } = makeCanvas(w, h);
    const step = opt.stride / opt.fallbackFps;
    const total = Math.floor((opt.end - opt.start) / step) + 1;
    for (let i = 0; i < total; i++) {
      if (opt.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const tt = opt.start + i * step;
      await seekTo(v, tt);
      ctx.drawImage(v, 0, 0, w, h);
      yield { canvas, mediaTime: tt, total };
    }
  } finally {
    URL.revokeObjectURL(url);
    v.removeAttribute('src');
    v.load();
  }
}

function seekTo(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((res) => {
    const done = () => {
      v.removeEventListener('seeked', onSeeked);
      res();
    };
    const onSeeked = () => {
      if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(() => done());
      else done();
    };
    v.addEventListener('seeked', onSeeked);
    v.currentTime = t;
    // 部分瀏覽器 seek 後不觸發畫面回呼，設定逾時保護
    setTimeout(done, 1500);
  });
}
