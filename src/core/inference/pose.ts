import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

export type PoseModel = 'full' | 'heavy';

const REMOTE = {
  full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
  heavy: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task',
};

export const POSE_MODEL_VERSION = 'mp-pose-1.0.1';

async function localOrRemote(local: string, remote: string): Promise<string> {
  try {
    const r = await fetch(local, { method: 'HEAD' });
    const type = r.headers.get('content-type') ?? '';
    // 開發伺服器找不到檔案時會回傳 index.html
    if (r.ok && !type.includes('text/html')) return local;
  } catch {
    // ignore
  }
  return remote;
}

export async function createPoseLandmarker(model: PoseModel): Promise<PoseLandmarker> {
  const base = import.meta.env.BASE_URL;
  const fileset = await FilesetResolver.forVisionTasks(`${base}wasm/mediapipe`);
  const modelAssetPath = await localOrRemote(`${base}models/pose_landmarker_${model}.task`, REMOTE[model]);
  const make = (delegate: 'GPU' | 'CPU') =>
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  try {
    return await make('GPU');
  } catch {
    return make('CPU');
  }
}
