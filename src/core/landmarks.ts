import type { FrameData, Handedness } from '../types';

/** MediaPipe Pose 33 點索引（left/right 為被拍攝者本人的左右） */
export const LM = {
  nose: 0,
  leftEar: 7,
  rightEar: 8,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftPinky: 17,
  rightPinky: 18,
  leftIndex: 19,
  rightIndex: 20,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
  leftHeel: 29,
  rightHeel: 30,
  leftFoot: 31,
  rightFoot: 32,
} as const;

export const POSE_CONNECTIONS: [number, number][] = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32],
  [15, 17], [15, 19], [17, 19], [16, 18], [16, 20], [18, 20],
  [0, 7], [0, 8],
];

export const N_LM = 33;
export const POSE2D_STRIDE = 4;
export const POSE3D_STRIDE = 3;

export interface Pt {
  x: number;
  y: number;
}

/** 前導側（右打者＝左側）與後側的關鍵點 */
export function sides(hand: Handedness) {
  const rh = hand === 'right';
  return {
    leadShoulder: rh ? LM.leftShoulder : LM.rightShoulder,
    trailShoulder: rh ? LM.rightShoulder : LM.leftShoulder,
    leadElbow: rh ? LM.leftElbow : LM.rightElbow,
    leadWrist: rh ? LM.leftWrist : LM.rightWrist,
    trailWrist: rh ? LM.rightWrist : LM.leftWrist,
    leadIndex: rh ? LM.leftIndex : LM.rightIndex,
    leadPinky: rh ? LM.leftPinky : LM.rightPinky,
    trailHip: rh ? LM.rightHip : LM.leftHip,
    trailKnee: rh ? LM.rightKnee : LM.leftKnee,
    trailAnkle: rh ? LM.rightAnkle : LM.leftAnkle,
    /** 後方視角下，球在畫面上的方向（右打者在右側） */
    toBall: rh ? 1 : -1,
  };
}

/** 讀取第 f 格第 k 點的像素座標 */
export function lm(fd: FrameData, f: number, k: number, W = 1, H = 1): Pt {
  const o = (f * 33 + k) * POSE2D_STRIDE;
  return { x: fd.pose2d[o] * W, y: fd.pose2d[o + 1] * H };
}

export function vis(fd: FrameData, f: number, k: number): number {
  return fd.pose2d[(f * 33 + k) * POSE2D_STRIDE + 3];
}

export function lm3(fd: FrameData, f: number, k: number): [number, number, number] {
  const o = (f * 33 + k) * POSE3D_STRIDE;
  return [fd.pose3d[o], fd.pose3d[o + 1], fd.pose3d[o + 2]];
}

export function mid(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function handsCenter(fd: FrameData, f: number, W = 1, H = 1): Pt {
  return mid(lm(fd, f, LM.leftWrist, W, H), lm(fd, f, LM.rightWrist, W, H));
}

export function hipCenter(fd: FrameData, f: number, W = 1, H = 1): Pt {
  return mid(lm(fd, f, LM.leftHip, W, H), lm(fd, f, LM.rightHip, W, H));
}

export function shoulderCenter(fd: FrameData, f: number, W = 1, H = 1): Pt {
  return mid(lm(fd, f, LM.leftShoulder, W, H), lm(fd, f, LM.rightShoulder, W, H));
}

export function clubPt(fd: FrameData, f: number, W = 1, H = 1): Pt | null {
  const x = fd.club[f * 2];
  if (Number.isNaN(x)) return null;
  return { x: x * W, y: fd.club[f * 2 + 1] * H };
}

/** 三點夾角（b 為頂點），單位度 */
export function angle3(a: Pt, b: Pt, c: Pt): number {
  const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
  const d = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (d === 0) return NaN;
  const cos = Math.min(1, Math.max(-1, (v1x * v2x + v1y * v2y) / d));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** 線段 a→b 與垂直線的夾角（度，0 = 垂直） */
export function angleFromVertical(a: Pt, b: Pt): number {
  return (Math.atan2(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) * 180) / Math.PI;
}

/** 線段 a→b 與水平線的夾角（度，0 = 水平） */
export function angleFromHorizontal(a: Pt, b: Pt): number {
  return (Math.atan2(Math.abs(b.y - a.y), Math.abs(b.x - a.x)) * 180) / Math.PI;
}

/** 點 p 到直線 a-b 的有號距離（畫面上方為正） */
export function signedDistAbove(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return 0;
  // 讓方向固定為從左到右，使「上方」判斷一致
  const sx = dx >= 0 ? 1 : -1;
  const cross = (sx * dx) * (p.y - a.y) - (sx * dy) * (p.x - a.x);
  return -cross / len;
}
