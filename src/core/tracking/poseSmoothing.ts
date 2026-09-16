import type { FrameData } from '../../types';
import { N_LM, POSE2D_STRIDE, POSE3D_STRIDE } from '../landmarks';
import { fillGapsLinear, zeroPhaseOneEuro } from './filters';

/**
 * 對姿態點做缺口補齊 + 零相位 One Euro 平滑（就地修改）
 * 可見度 < minVis 的點視為缺失
 */
export function smoothPose(fd: FrameData, minVis = 0.4) {
  const { n, t } = fd;
  if (n < 3) return;
  const buf = new Float64Array(n);
  for (let k = 0; k < N_LM; k++) {
    for (let c = 0; c < 2; c++) {
      for (let f = 0; f < n; f++) {
        const o = (f * N_LM + k) * POSE2D_STRIDE;
        buf[f] = fd.pose2d[o + 3] >= minVis ? fd.pose2d[o + c] : NaN;
      }
      const filled = fillGapsLinear(buf, t, 0.5);
      // 手腕、手部移動快，beta 較高以降低延遲
      const fast = k >= 13 && k <= 22;
      const sm = zeroPhaseOneEuro(fillIfAllNaN(filled, fd, k, c), t, fast ? 4 : 1.5, fast ? 0.5 : 0.1);
      for (let f = 0; f < n; f++) fd.pose2d[(f * N_LM + k) * POSE2D_STRIDE + c] = sm[f];
    }
    for (let c = 0; c < 3; c++) {
      for (let f = 0; f < n; f++) buf[f] = fd.pose3d[(f * N_LM + k) * POSE3D_STRIDE + c];
      const sm = zeroPhaseOneEuro(buf, t, 1.5, 0.1);
      for (let f = 0; f < n; f++) fd.pose3d[(f * N_LM + k) * POSE3D_STRIDE + c] = sm[f];
    }
  }
}

function fillIfAllNaN(v: Float64Array, fd: FrameData, k: number, c: number): Float64Array {
  if (!Number.isNaN(v[0])) return v;
  // 全部缺失：退回原始值
  const out = new Float64Array(v.length);
  for (let f = 0; f < v.length; f++) out[f] = fd.pose2d[(f * N_LM + k) * POSE2D_STRIDE + c];
  return out;
}
