import type { FrameData } from '../../types';
import { N_LM, POSE2D_STRIDE, POSE3D_STRIDE } from '../landmarks';
import { fillGapsLinear, zeroPhaseOneEuro } from './filters';

/** 低可見度缺口在此長度內以前後可信值內插，更長則沿用模型的原始估計 */
const MAX_INTERP_GAP_SEC = 0.5;

/**
 * 對姿態點做缺口補齊 + 零相位 One Euro 平滑（就地修改）
 * - 可見度 < minVis 的點視為不可信：短缺口內插，長缺口沿用 MediaPipe 的遮擋估計值
 * - 完全沒偵測到人物的格（NaN）以最近值補齊
 * 可見度欄位保持原值，供圖層判斷是否繪製
 */
export function smoothPose(fd: FrameData, minVis = 0.4) {
  const { n, t } = fd;
  if (n < 3) return;
  const buf = new Float64Array(n);
  const raw = new Float64Array(n);
  for (let k = 0; k < N_LM; k++) {
    for (let c = 0; c < 2; c++) {
      for (let f = 0; f < n; f++) {
        const o = (f * N_LM + k) * POSE2D_STRIDE;
        raw[f] = fd.pose2d[o + c];
        buf[f] = fd.pose2d[o + 3] >= minVis ? raw[f] : NaN;
      }
      const interp = fillGapsLinear(buf, t, MAX_INTERP_GAP_SEC);
      for (let f = 0; f < n; f++) if (Number.isNaN(interp[f])) interp[f] = raw[f];
      const filled = fillGapsLinear(interp, t);
      // 手腕、手部移動快，beta 較高以降低延遲
      const fast = k >= 13 && k <= 22;
      const sm = zeroPhaseOneEuro(filled, t, fast ? 4 : 1.5, fast ? 0.5 : 0.1);
      for (let f = 0; f < n; f++) fd.pose2d[(f * N_LM + k) * POSE2D_STRIDE + c] = sm[f];
    }
    for (let c = 0; c < 3; c++) {
      for (let f = 0; f < n; f++) buf[f] = fd.pose3d[(f * N_LM + k) * POSE3D_STRIDE + c];
      const sm = zeroPhaseOneEuro(fillGapsLinear(buf, t), t, 1.5, 0.1);
      for (let f = 0; f < n; f++) fd.pose3d[(f * N_LM + k) * POSE3D_STRIDE + c] = sm[f];
    }
  }
}
