import type { FrameData, SessionRecord } from '../../types';
import { N_LM, POSE2D_STRIDE } from '../landmarks';
import { SERIES_KEYS, type MetricSeries } from '../metrics/computeMetrics';

export function sessionToJson(s: SessionRecord, fd: FrameData, series: MetricSeries): Blob {
  const { thumbnail: _thumb, ...meta } = s;
  const frames = Array.from({ length: fd.n }, (_, f) => ({
    t: fd.t[f],
    mediaT: fd.mediaT[f],
    club: Number.isNaN(fd.club[f * 2]) ? null : [fd.club[f * 2], fd.club[f * 2 + 1]],
    clubSource: fd.clubSource[f],
    pose: Array.from({ length: N_LM }, (_, k) => {
      const o = (f * N_LM + k) * POSE2D_STRIDE;
      return [round(fd.pose2d[o]), round(fd.pose2d[o + 1]), round(fd.pose2d[o + 3])];
    }),
    ...Object.fromEntries(SERIES_KEYS.map((k) => [k, round(series[k][f])])),
  }));
  return new Blob([JSON.stringify({ ...meta, frames }, null, 1)], { type: 'application/json' });
}

export function sessionToCsv(fd: FrameData, series: MetricSeries): Blob {
  const head = ['frame', 't', 'mediaT', 'clubX', 'clubY', 'clubSource', ...SERIES_KEYS];
  const rows = [head.join(',')];
  for (let f = 0; f < fd.n; f++) {
    rows.push(
      [f, fd.t[f].toFixed(4), fd.mediaT[f].toFixed(4), fmt(fd.club[f * 2]), fmt(fd.club[f * 2 + 1]), fd.clubSource[f], ...SERIES_KEYS.map((k) => fmt(series[k][f]))].join(','),
    );
  }
  // BOM 讓 Excel 正確辨識 UTF-8
  return new Blob(['﻿' + rows.join('\n')], { type: 'text/csv' });
}

function round(v: number) {
  return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null;
}

function fmt(v: number) {
  return Number.isFinite(v) ? v.toFixed(4) : '';
}
