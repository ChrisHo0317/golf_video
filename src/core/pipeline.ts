import type { Calibration, CaptureInfo, FrameData, Metrics, Phases } from '../types';
import { calibrateByHeight, expectedHandToHeadPx } from './calibration/calibration';
import { computeMetrics, computeSeries, type MetricSeries } from './metrics/computeMetrics';
import { detectPhases } from './phases/detectPhases';
import { trackClub } from './tracking/clubTracker';

export interface AnalysisResult {
  phases: Phases;
  calibration: Calibration;
  metrics: Metrics;
  series: MetricSeries;
  clubLengthPx: number;
}

/**
 * 推論完成後的後處理（桿頭追蹤 → 階段 → 校正 → 指標）
 * 會就地寫入 fd.club / fd.clubSource；使用者修正桿頭或階段後可重跑
 */
export function analyze(
  fd: FrameData,
  capture: CaptureInfo,
  W: number,
  H: number,
  phasesOverride?: Phases | null,
): AnalysisResult | null {
  const coarse = phasesOverride ?? detectPhases(fd, { W, H, useClub: false });
  if (!coarse) return null;
  const calibration =
    calibrateByHeight(fd, coarse.address, capture.heightCm, W, H) ?? ({ pxPerMeter: H / 1.8, method: 'height' } as Calibration);

  const track = trackClub(fd, {
    W,
    H,
    handedness: capture.handedness,
    fallbackLengthPx: expectedHandToHeadPx(calibration, capture.clubLengthCm),
  });
  fd.club = track.club;
  fd.clubSource = track.clubSource;

  const phases = phasesOverride ?? detectPhases(fd, { W, H, useClub: track.coverage >= 0.3 }) ?? coarse;
  const ctx = {
    fd,
    phases,
    calibration,
    capture,
    W,
    H,
    clubLengthPx: track.lengthPx,
    clubCoverage: track.coverage,
  };
  const series = computeSeries(ctx);
  const metrics = computeMetrics(ctx, series);
  return { phases, calibration, metrics, series, clubLengthPx: track.lengthPx };
}
