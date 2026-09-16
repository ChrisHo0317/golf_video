export type ViewAngle = 'dtl' | 'faceOn';
export type Handedness = 'right' | 'left';
export type ClubType = 'driver' | 'wood' | 'hybrid' | 'iron' | 'wedge' | 'putter';

/** 桿頭座標來源 */
export const ClubSource = {
  Model: 0,
  Predicted: 1,
  Manual: 2,
  None: 3,
  HandEstimate: 4,
  /** 影像桿身偵測（不需模型） */
  Shaft: 5,
} as const;
export type ClubSourceValue = (typeof ClubSource)[keyof typeof ClubSource];

export interface VideoMeta {
  /** 儲存於 OPFS / IDB 的鍵 */
  storageKey: string;
  fileName: string;
  mimeType: string;
  durationSec: number;
  /** 檔案內標示的 FPS */
  fps: number;
  /** 旋轉校正後的寬高 */
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  /** 慢動作倍率：真實時間 = 媒體時間 / slowMoFactor */
  slowMoFactor: number;
  trimStart: number;
  trimEnd: number;
}

export interface CaptureInfo {
  viewAngle: ViewAngle;
  handedness: Handedness;
  heightCm: number;
  clubType: ClubType;
  clubLengthCm: number;
}

/** 各揮桿階段對應的影格索引 */
export interface Phases {
  address: number;
  takeaway: number;
  top: number;
  impact: number;
  finish: number;
}

export interface Calibration {
  /** 以影片像素（旋轉後原解析度）為單位 */
  pxPerMeter: number;
  method: 'height' | 'club';
}

export interface Metrics {
  tempoRatio: number | null;
  backswingSec: number | null;
  downswingSec: number | null;
  clubSpeedMax: number | null; // m/s
  clubSpeedImpact: number | null; // m/s
  handSpeedMax: number | null; // m/s
  shaftPlaneAddressDeg: number | null;
  shaftAngleTopDeg: number | null;
  overTheTopPct: number | null; // 下桿前半段桿頭高於肩平面的比例
  pathIndicator: number | null; // + 內側接近 / - 外側接近（相對桿長）
  pathLabel: 'inToOut' | 'neutral' | 'outToIn' | null;
  spineAddressDeg: number | null;
  spineImpactDeg: number | null;
  spineChangeDeg: number | null;
  earlyExtensionCm: number | null;
  headDxMaxCm: number | null;
  headDyMaxCm: number | null;
  headDxImpactCm: number | null;
  headDyImpactCm: number | null;
  trailKneeAddressDeg: number | null;
  trailKneeImpactDeg: number | null;
  leadArmTopDeg: number | null;
  shoulderTurnTopDeg: number | null;
  hipTurnTopDeg: number | null;
  xFactorTopDeg: number | null;
  handHeightTopCm: number | null;
  clubTrackCoverage: number; // 0..1 有模型/手動資料的比例
}

export const CLUB_CANDS = 5;
/** 每個候選：x, y, conf, flags, bgRatio（舊紀錄為 4 欄，沒有 bgRatio） */
export const CAND_STRIDE = 5;
/** 候選旗標：桿頭超出畫面，長度為推估值 */
export const CAND_OUT_OF_FRAME = 1;
/** 候選旗標：來自 YOLO 模型 */
export const CAND_FROM_MODEL = 2;

/** 逐格資料（以 TypedArray 儲存），座標為 0..1 正規化（旋轉後畫面） */
export interface FrameData {
  n: number;
  /** 真實時間（秒，已套用慢動作倍率，從 trimStart 起算） */
  t: Float64Array;
  /** 原始媒體時間（秒），用於影片同步 */
  mediaT: Float64Array;
  /** n × 33 × 4 : x, y, z, visibility（已平滑） */
  pose2d: Float32Array;
  /** n × 33 × 3 : 世界座標（公尺，以髖為原點） */
  pose3d: Float32Array;
  /** 原始（未平滑）偵測：n × 3 : x, y, conf */
  clubRaw: Float32Array;
  clubRawSource: Uint8Array;
  /** 每格多個桿頭候選：n × CLUB_CANDS × CAND_STRIDE（舊紀錄可能沒有） */
  clubCands?: Float32Array;
  /** 追蹤後：n × 2 : x, y */
  club: Float32Array;
  clubSource: Uint8Array;
}

export interface SessionRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  title: string;
  notes: string;
  favorite: boolean;
  video: VideoMeta;
  capture: CaptureInfo;
  phases: Phases | null;
  /** 使用者手動調整過階段 */
  phasesManual?: boolean;
  calibration: Calibration | null;
  metrics: Metrics | null;
  thumbnail: Blob | null;
  modelVersions: { pose: string; club: string };
}

export interface FramesRecord {
  sessionId: string;
  /** gzip 壓縮後的 FrameData 序列化結果 */
  blob: Blob;
}
