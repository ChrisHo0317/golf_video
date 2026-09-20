import { CAND_FROM_MODEL, CLUB_CANDS, ClubSource, type FrameData, type VideoMeta } from '../../types';
import { LM, N_LM, weightedMid } from '../landmarks';
import { buildBackground } from '../video/background';
import { frameSource } from '../video/frameSource';
import { ClubDetector, type ClubDetection } from './clubDetector';
import { createPoseLandmarker, POSE_MODEL_VERSION, type PoseModel } from './pose';
import { ShaftDetector } from './shaftDetector';

export const SHAFT_DETECTOR_VERSION = 'shaft-cv-10';

export interface InferenceProgress {
  stage: 'loading' | 'processing' | 'done';
  done: number;
  total: number;
  /** 最近一格的預覽畫面 */
  preview?: OffscreenCanvas | HTMLCanvasElement;
}

export interface InferenceOptions {
  poseModel: PoseModel;
  stride: number;
  maxSide: number;
  signal?: AbortSignal;
  onProgress: (p: InferenceProgress) => void;
}

export interface Thumb {
  mediaTime: number;
  image: ImageData;
}

export interface InferenceOutput {
  frames: FrameData;
  modelVersions: { pose: string; club: string };
  /** 分析過程中順便擷取的小縮圖（約每 0.1 秒一張），用來產生紀錄縮圖，不需再開影片 */
  thumbs: Thumb[];
}

const THUMB_MAX = 200;

let clubDetectorPromise: Promise<ClubDetector | null> | null = null;
export function getClubDetector() {
  clubDetectorPromise ??= ClubDetector.load().catch(() => null);
  return clubDetectorPromise;
}

export async function runInference(file: Blob, video: VideoMeta, opt: InferenceOptions): Promise<InferenceOutput> {
  opt.onProgress({ stage: 'loading', done: 0, total: 0 });
  const [pose, club] = await Promise.all([createPoseLandmarker(opt.poseModel), getClubDetector()]);

  const mediaT: number[] = [];
  const pose2d: number[] = [];
  const pose3d: number[] = [];
  const clubRaw: number[] = [];
  const clubRawSrc: number[] = [];
  const cands: number[] = [];
  const thumbs: Thumb[] = [];
  let thumbCtx: CanvasRenderingContext2D | null = null;
  let lastThumbT = -Infinity;
  const shaft = new ShaftDetector();
  const srcOpt = {
    start: video.trimStart,
    end: video.trimEnd,
    rotation: video.rotation,
    maxSide: opt.maxSide,
    fallbackFps: video.fps,
    signal: opt.signal,
  };
  const estFrames = Math.ceil((video.trimEnd - video.trimStart) * video.fps);
  const bg = await buildBackground(file, srcOpt, estFrames).catch(() => null);
  let lastTs = -1;
  let lastYield = performance.now();

  try {
    for await (const fr of frameSource(file, { ...srcOpt, stride: opt.stride })) {
      let ts = Math.round(fr.mediaTime * 1000);
      if (ts <= lastTs) ts = lastTs + 1;
      lastTs = ts;

      const res = pose.detectForVideo(fr.canvas as unknown as HTMLCanvasElement, ts);
      const p = res.landmarks[0];
      const w = res.worldLandmarks[0];
      for (let k = 0; k < N_LM; k++) {
        if (p) pose2d.push(p[k].x, p[k].y, p[k].z, p[k].visibility ?? 0);
        else pose2d.push(NaN, NaN, NaN, 0);
        if (w) pose3d.push(w[k].x, w[k].y, w[k].z);
        else pose3d.push(NaN, NaN, NaN);
      }

      const cw = fr.canvas.width;
      const ch = fr.canvas.height;
      // 候選：模型偵測在前，影像桿身偵測補滿
      const frameCands: { x: number; y: number; conf: number; flags: number; src: number; bgRatio: number }[] = [];
      if (club) {
        const roi = p ? roiFromPose(p, cw, ch) : null;
        const found = await club.detect(fr.canvas, roi);
        const best = pickCandidate(found, p, cw, ch);
        if (best) frameCands.push({ ...best, flags: 0, src: ClubSource.Model, bgRatio: 0 });
        for (const c of found) if (c !== best && frameCands.length < 2) frameCands.push({ ...c, flags: 0, src: ClubSource.Model, bgRatio: 0 });
      }
      if (p) {
        const ctx = fr.canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
        for (const c of shaft.detect(ctx, cw, ch, p, CLUB_CANDS - frameCands.length, bg)) frameCands.push({ ...c, src: ClubSource.Shaft });
      }
      const top = frameCands[0];
      if (top) clubRaw.push(top.x / cw, top.y / ch, top.conf);
      else clubRaw.push(NaN, NaN, 0);
      clubRawSrc.push(top ? top.src : ClubSource.None);
      for (let i = 0; i < CLUB_CANDS; i++) {
        const c = frameCands[i];
        if (c) cands.push(c.x / cw, c.y / ch, c.conf, c.flags | (c.src === ClubSource.Model ? CAND_FROM_MODEL : 0), c.bgRatio);
        else cands.push(NaN, NaN, 0, 0, 0);
      }
      mediaT.push(fr.mediaTime);

      if (fr.mediaTime - lastThumbT >= 0.1) {
        lastThumbT = fr.mediaTime;
        const s = Math.min(1, THUMB_MAX / Math.max(cw, ch));
        const tw = Math.max(1, Math.round(cw * s));
        const th = Math.max(1, Math.round(ch * s));
        if (!thumbCtx) {
          const c = document.createElement('canvas');
          c.width = tw;
          c.height = th;
          thumbCtx = c.getContext('2d', { willReadFrequently: true });
        }
        if (thumbCtx) {
          thumbCtx.drawImage(fr.canvas as CanvasImageSource, 0, 0, tw, th);
          thumbs.push({ mediaTime: fr.mediaTime, image: thumbCtx.getImageData(0, 0, tw, th) });
        }
      }

      if (performance.now() - lastYield > 100) {
        opt.onProgress({ stage: 'processing', done: mediaT.length, total: fr.total, preview: fr.canvas });
        await new Promise((r) => setTimeout(r, 0));
        lastYield = performance.now();
      }
    }
  } finally {
    pose.close();
  }

  const n = mediaT.length;
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = (mediaT[i] - mediaT[0]) / video.slowMoFactor;
  const clubRawSource = Uint8Array.from(clubRawSrc);

  opt.onProgress({ stage: 'done', done: n, total: n });
  return {
    frames: {
      n,
      t,
      mediaT: Float64Array.from(mediaT),
      pose2d: Float32Array.from(pose2d),
      pose3d: Float32Array.from(pose3d),
      clubRaw: Float32Array.from(clubRaw),
      clubRawSource,
      clubCands: Float32Array.from(cands),
      club: new Float32Array(n * 2).fill(NaN),
      clubSource: new Uint8Array(n).fill(ClubSource.None),
    },
    thumbs,
    modelVersions: { pose: `${POSE_MODEL_VERSION}-${opt.poseModel}`, club: club ? `${club.meta.version}+${SHAFT_DETECTOR_VERSION}` : SHAFT_DETECTOR_VERSION },
  };
}

type NLm = { x: number; y: number; visibility?: number }[];

/** 以雙手為中心、約 5.5 倍軀幹長的正方形區域 */
function roiFromPose(p: NLm, W: number, H: number) {
  const h = weightedMid(p[LM.leftWrist], p[LM.leftWrist].visibility ?? 1, p[LM.rightWrist], p[LM.rightWrist].visibility ?? 1);
  const hx = h.x * W;
  const hy = h.y * H;
  const sx = ((p[LM.leftShoulder].x + p[LM.rightShoulder].x) / 2) * W;
  const sy = ((p[LM.leftShoulder].y + p[LM.rightShoulder].y) / 2) * H;
  const px = ((p[LM.leftHip].x + p[LM.rightHip].x) / 2) * W;
  const py = ((p[LM.leftHip].y + p[LM.rightHip].y) / 2) * H;
  const torso = Math.hypot(sx - px, sy - py);
  if (!Number.isFinite(torso) || torso < 10) return null;
  const size = Math.min(Math.max(W, H), torso * 5.5);
  return { x: hx - size / 2, y: hy - size / 2, size };
}

/** 從候選中挑選：信心值 × 與雙手距離合理性 */
function pickCandidate(cands: ClubDetection[], p: NLm | undefined, W: number, H: number): ClubDetection | null {
  if (!cands.length) return null;
  if (!p) return cands[0];
  const h = weightedMid(p[LM.leftWrist], p[LM.leftWrist].visibility ?? 1, p[LM.rightWrist], p[LM.rightWrist].visibility ?? 1);
  const hx = h.x * W;
  const hy = h.y * H;
  const sx = ((p[LM.leftShoulder].x + p[LM.rightShoulder].x) / 2) * W;
  const sy = ((p[LM.leftShoulder].y + p[LM.rightShoulder].y) / 2) * H;
  const px = ((p[LM.leftHip].x + p[LM.rightHip].x) / 2) * W;
  const py = ((p[LM.leftHip].y + p[LM.rightHip].y) / 2) * H;
  const L = Math.hypot(sx - px, sy - py) * 1.9;
  let best: ClubDetection | null = null;
  let bestScore = -1;
  for (const c of cands) {
    const d = Math.hypot(c.x - hx, c.y - hy);
    const ratio = d / L;
    const gate = ratio < 0.2 || ratio > 1.8 ? 0.2 : 1;
    const score = c.conf * gate;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}
