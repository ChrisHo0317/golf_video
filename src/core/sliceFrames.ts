import { CAND_STRIDE, CLUB_CANDS, type FrameData, type Phases } from '../types';

/** 取出 [from, to] 區間的逐格資料（含端點），時間軸重新以第一格起算 */
export function sliceFrames(fd: FrameData, from: number, to: number, mediaOffset: number): FrameData {
  const n = to - from + 1;
  const cut = <T extends Float32Array | Float64Array | Uint8Array>(a: T, stride: number): T => a.slice(from * stride, (to + 1) * stride) as T;
  const mediaT = cut(fd.mediaT, 1);
  for (let i = 0; i < mediaT.length; i++) mediaT[i] -= mediaOffset;
  const t = fd.t.slice(from, to + 1);
  const t0 = t[0];
  for (let i = 0; i < t.length; i++) t[i] -= t0;
  return {
    n,
    t,
    mediaT,
    pose2d: cut(fd.pose2d, 33 * 4),
    pose3d: cut(fd.pose3d, 33 * 3),
    clubRaw: cut(fd.clubRaw, 3),
    clubRawSource: cut(fd.clubRawSource, 1),
    clubCands: fd.clubCands ? fd.clubCands.slice(from * CLUB_CANDS * CAND_STRIDE, (to + 1) * CLUB_CANDS * CAND_STRIDE) : undefined,
    club: cut(fd.club, 2),
    clubSource: cut(fd.clubSource, 1),
  };
}

/** 階段的格號跟著位移，並限制在新的範圍內 */
export function shiftPhases(p: Phases, from: number, n: number): Phases {
  const clamp = (f: number) => Math.min(n - 1, Math.max(0, f - from));
  return { address: clamp(p.address), takeaway: clamp(p.takeaway), top: clamp(p.top), impact: clamp(p.impact), finish: clamp(p.finish) };
}
