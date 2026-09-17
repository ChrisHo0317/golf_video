import type { Calibration, ClubType, FrameData } from '../../types';
import { LM, dist, hipCenter, lm, shoulderCenter } from '../landmarks';

export const DEFAULT_CLUB_LENGTH_CM: Record<ClubType, number> = {
  driver: 114,
  wood: 107,
  hybrid: 101,
  iron: 94,
  wedge: 89,
  putter: 86,
};

/** 人體比例（Drillis & Contini）：大腿 0.245H、小腿 0.246H、髖至肩 0.29H */
const LEG_TORSO_RATIO = 0.245 + 0.246 + 0.29;
/** 雙手（手腕）中心到握把末端的沿桿距離約 0.10 公尺（以人工標記的影片實測） */
const GRIP_OFFSET_M = 0.1;

/** 以身高換算：取準備姿勢附近多格的腿長 + 軀幹長中位數 */
export function calibrateByHeight(fd: FrameData, address: number, heightCm: number, W: number, H: number): Calibration | null {
  const samples: number[] = [];
  const span = Math.max(1, Math.round(fd.n * 0.02));
  for (let f = Math.max(0, address - span); f <= Math.min(fd.n - 1, address + span); f++) {
    const legL = dist(lm(fd, f, LM.leftHip, W, H), lm(fd, f, LM.leftKnee, W, H)) + dist(lm(fd, f, LM.leftKnee, W, H), lm(fd, f, LM.leftAnkle, W, H));
    const legR = dist(lm(fd, f, LM.rightHip, W, H), lm(fd, f, LM.rightKnee, W, H)) + dist(lm(fd, f, LM.rightKnee, W, H), lm(fd, f, LM.rightAnkle, W, H));
    const torso = dist(hipCenter(fd, f, W, H), shoulderCenter(fd, f, W, H));
    // 後方視角兩腿可能互相遮擋，取較長者
    samples.push(Math.max(legL, legR) + torso);
  }
  samples.sort((a, b) => a - b);
  const px = samples[Math.floor(samples.length / 2)];
  if (!px || !heightCm) return null;
  return { pxPerMeter: px / (LEG_TORSO_RATIO * (heightCm / 100)), method: 'height' };
}

/** 以球桿長度換算（需要桿頭追蹤的手-桿頭距離） */
export function calibrateByClub(handToHeadPx: number, clubLengthCm: number): Calibration | null {
  const m = clubLengthCm / 100 - GRIP_OFFSET_M;
  if (!handToHeadPx || m <= 0) return null;
  return { pxPerMeter: handToHeadPx / m, method: 'club' };
}

/** 依身高推估手到桿頭距離（像素），作為桿頭追蹤的預設值 */
export function expectedHandToHeadPx(cal: Calibration, clubLengthCm: number): number {
  return cal.pxPerMeter * (clubLengthCm / 100 - GRIP_OFFSET_M);
}
