import { ClubSource, type FrameData, type VideoMeta } from '../../types';
import { LM, N_LM, weightedMid } from '../landmarks';
import { frameSource } from '../video/frameSource';
import { ClubDetector, type ClubDetection } from './clubDetector';
import { createPoseLandmarker, POSE_MODEL_VERSION, type PoseModel } from './pose';
import { ShaftDetector } from './shaftDetector';

export const SHAFT_DETECTOR_VERSION = 'shaft-cv-1';

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

export interface InferenceOutput {
  frames: FrameData;
  modelVersions: { pose: string; club: string };
}

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
  const shaft = new ShaftDetector();
  let lastTs = -1;
  let lastYield = performance.now();

  try {
    for await (const fr of frameSource(file, {
      start: video.trimStart,
      end: video.trimEnd,
      rotation: video.rotation,
      maxSide: opt.maxSide,
      fallbackFps: video.fps,
      stride: opt.stride,
      signal: opt.signal,
    })) {
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
      let det: ClubDetection | null = null;
      let src: number = ClubSource.None;
      if (club) {
        const roi = p ? roiFromPose(p, cw, ch) : null;
        const cands = await club.detect(fr.canvas, roi);
        det = pickCandidate(cands, p, cw, ch);
        if (det) src = ClubSource.Model;
      }
      if (!det && p) {
        // 沒有模型或模型沒抓到：以影像桿身偵測補上
        const ctx = fr.canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
        det = shaft.detect(ctx, cw, ch, p, (fr.mediaTime - video.trimStart) / video.slowMoFactor);
        if (det) src = ClubSource.Shaft;
      }
      if (det) clubRaw.push(det.x / cw, det.y / ch, det.conf);
      else clubRaw.push(NaN, NaN, 0);
      clubRawSrc.push(src);
      mediaT.push(fr.mediaTime);

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
      club: new Float32Array(n * 2).fill(NaN),
      clubSource: new Uint8Array(n).fill(ClubSource.None),
    },
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
