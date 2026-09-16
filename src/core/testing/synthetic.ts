import { ClubSource, type FrameData } from '../../types';
import { LM, N_LM } from '../landmarks';

/** 合成揮桿參數（正規化座標，W = H） */
export const SYN = {
  fps: 60,
  duration: 4,
  shoulderC: { x: 0.47, y: 0.42 },
  armR: 0.2,
  clubL: 0.3,
  takeawayT: 1.0,
  topT: 2.0,
  impactT: 2.3,
  finishT: 2.8,
  shoulderTurnTop: 90,
  hipTurnTop: 45,
};

const deg = Math.PI / 180;
const ease = (u: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, u)));

/** 雙手繞肩中心的角度（y 向下，90° = 正下方） */
export function handAngle(t: number): number {
  const { takeawayT, topT, impactT, finishT } = SYN;
  if (t < takeawayT) return 90;
  if (t < topT) return 90 - 150 * ease((t - takeawayT) / (topT - takeawayT));
  if (t < impactT) return -60 + 150 * ((t - topT) / (impactT - topT)) ** 2;
  if (t < finishT) return 90 + 160 * Math.sin(((t - impactT) / (finishT - impactT)) * (Math.PI / 2));
  return 250;
}

function turn(t: number, top: number): number {
  const { takeawayT, topT, impactT, finishT } = SYN;
  if (t < takeawayT) return 0;
  if (t < topT) return top * ease((t - takeawayT) / (topT - takeawayT));
  if (t < impactT) return top * (1 - (t - topT) / (impactT - topT));
  if (t < finishT) return -top * ((t - impactT) / (finishT - impactT));
  return -top;
}

export function syntheticSwing(): FrameData {
  const n = SYN.fps * SYN.duration;
  const fd: FrameData = {
    n,
    t: new Float64Array(n),
    mediaT: new Float64Array(n),
    pose2d: new Float32Array(n * N_LM * 4),
    pose3d: new Float32Array(n * N_LM * 3),
    clubRaw: new Float32Array(n * 3),
    clubRawSource: new Uint8Array(n),
    club: new Float32Array(n * 2).fill(NaN),
    clubSource: new Uint8Array(n).fill(ClubSource.None),
  };
  const set2 = (f: number, k: number, x: number, y: number) => {
    const o = (f * N_LM + k) * 4;
    fd.pose2d[o] = x;
    fd.pose2d[o + 1] = y;
    fd.pose2d[o + 2] = 0;
    fd.pose2d[o + 3] = 1;
  };
  const set3 = (f: number, k: number, x: number, y: number, z: number) => {
    const o = (f * N_LM + k) * 3;
    fd.pose3d[o] = x;
    fd.pose3d[o + 1] = y;
    fd.pose3d[o + 2] = z;
  };
  const c = SYN.shoulderC;
  for (let f = 0; f < n; f++) {
    const t = f / SYN.fps;
    fd.t[f] = t;
    fd.mediaT[f] = t + 0.5;
    for (let k = 0; k < N_LM; k++) set2(f, k, 0.45, 0.5);
    set2(f, LM.nose, 0.5, 0.33);
    set2(f, LM.leftEar, 0.49, 0.32);
    set2(f, LM.rightEar, 0.47, 0.32);
    set2(f, LM.leftShoulder, c.x + 0.02, c.y);
    set2(f, LM.rightShoulder, c.x - 0.02, c.y);
    set2(f, LM.leftHip, 0.46, 0.6);
    set2(f, LM.rightHip, 0.44, 0.6);
    set2(f, LM.leftKnee, 0.48, 0.75);
    set2(f, LM.rightKnee, 0.46, 0.75);
    set2(f, LM.leftAnkle, 0.46, 0.9);
    set2(f, LM.rightAnkle, 0.44, 0.9);

    const a = handAngle(t) * deg;
    const hx = c.x + SYN.armR * Math.cos(a);
    const hy = c.y + SYN.armR * Math.sin(a);
    set2(f, LM.leftWrist, hx, hy);
    set2(f, LM.rightWrist, hx, hy);
    set2(f, LM.leftElbow, c.x + 0.5 * SYN.armR * Math.cos(a), c.y + 0.5 * SYN.armR * Math.sin(a));
    const kx = c.x + (SYN.armR + 0.02) * Math.cos(a);
    const ky = c.y + (SYN.armR + 0.02) * Math.sin(a);
    for (const k of [LM.leftIndex, LM.leftPinky, LM.rightIndex, LM.rightPinky]) set2(f, k, kx, ky);

    const cx = c.x + (SYN.armR + SYN.clubL) * Math.cos(a);
    const cy = c.y + (SYN.armR + SYN.clubL) * Math.sin(a);
    fd.clubRaw.set([cx, cy, 0.9], f * 3);
    fd.clubRawSource[f] = ClubSource.Model;

    const sT = turn(t, SYN.shoulderTurnTop) * deg;
    const hT = turn(t, SYN.hipTurnTop) * deg;
    set3(f, LM.leftShoulder, -0.2 * Math.cos(sT), -0.5, -0.2 * Math.sin(sT));
    set3(f, LM.rightShoulder, 0.2 * Math.cos(sT), -0.5, 0.2 * Math.sin(sT));
    set3(f, LM.leftHip, -0.15 * Math.cos(hT), 0, -0.15 * Math.sin(hT));
    set3(f, LM.rightHip, 0.15 * Math.cos(hT), 0, 0.15 * Math.sin(hT));
  }
  return fd;
}

/** 決定性的偽亂數 */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
