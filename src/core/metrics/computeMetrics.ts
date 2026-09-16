import { ClubSource, type Calibration, type CaptureInfo, type FrameData, type Metrics, type Phases } from '../../types';
import {
  LM,
  angle3,
  angleFromHorizontal,
  angleFromVertical,
  clubPt,
  dist,
  handsCenter,
  hipCenter,
  lm,
  lm3,
  shoulderCenter,
  sides,
  signedDistAbove,
  type Pt,
} from '../landmarks';
import { movingAverage } from '../tracking/filters';

export interface MetricContext {
  fd: FrameData;
  phases: Phases;
  calibration: Calibration;
  capture: CaptureInfo;
  W: number;
  H: number;
  clubLengthPx: number;
  clubCoverage: number;
}

/** 時序曲線（每格一個值），NaN 表示無資料 */
export interface MetricSeries {
  clubSpeed: Float64Array; // m/s
  handSpeed: Float64Array; // m/s
  headDx: Float64Array; // cm，正值 = 往球方向
  headDy: Float64Array; // cm，正值 = 往上
  hipDepth: Float64Array; // cm，正值 = 往球方向（提早伸展）
  spineAngle: Float64Array; // 度，與垂直線夾角
  shoulderTurn: Float64Array; // 度
  hipTurn: Float64Array; // 度
  xFactor: Float64Array; // 度
}

export const SERIES_KEYS: (keyof MetricSeries)[] = [
  'clubSpeed',
  'handSpeed',
  'headDx',
  'headDy',
  'hipDepth',
  'spineAngle',
  'shoulderTurn',
  'hipTurn',
  'xFactor',
];

const TRUSTED_CLUB = new Set<number>([ClubSource.Model, ClubSource.Manual, ClubSource.Predicted]);

export function computeSeries(ctx: MetricContext): MetricSeries {
  const { fd, phases, calibration, capture, W, H } = ctx;
  const { n, t } = fd;
  const ppm = calibration.pxPerMeter;
  const s = sides(capture.handedness);
  const a = phases.address;
  const fps = (n - 1) / Math.max(t[n - 1] - t[0], 1e-6);
  const r = Math.max(1, Math.round(fps * 0.015));

  const speedOf = (pts: (Pt | null)[], trusted: (f: number) => boolean) => {
    const out = new Float64Array(n).fill(NaN);
    for (let f = 0; f < n; f++) {
      const i0 = Math.max(0, f - 1);
      const i1 = Math.min(n - 1, f + 1);
      const p0 = pts[i0];
      const p1 = pts[i1];
      if (!p0 || !p1 || !trusted(f)) continue;
      out[f] = dist(p0, p1) / ppm / Math.max(t[i1] - t[i0], 1e-6);
    }
    return movingAverage(out, r);
  };

  const clubPts = Array.from({ length: n }, (_, f) => clubPt(fd, f, W, H));
  const handPts = Array.from({ length: n }, (_, f) => handsCenter(fd, f, W, H));
  const clubSpeed = speedOf(clubPts, (f) => TRUSTED_CLUB.has(fd.clubSource[f]));
  const handSpeed = speedOf(handPts, () => true);

  const nose0 = lm(fd, a, LM.nose, W, H);
  const hip0 = hipCenter(fd, a, W, H);
  const headDx = new Float64Array(n);
  const headDy = new Float64Array(n);
  const hipDepth = new Float64Array(n);
  const spineAngle = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    const nose = lm(fd, f, LM.nose, W, H);
    headDx[f] = (((nose.x - nose0.x) * s.toBall) / ppm) * 100;
    headDy[f] = ((nose0.y - nose.y) / ppm) * 100;
    const hip = hipCenter(fd, f, W, H);
    hipDepth[f] = (((hip.x - hip0.x) * s.toBall) / ppm) * 100;
    spineAngle[f] = angleFromVertical(hip, shoulderCenter(fd, f, W, H));
  }

  const shoulderTurn = turnSeries(fd, LM.leftShoulder, LM.rightShoulder, a, phases.top);
  const hipTurn = turnSeries(fd, LM.leftHip, LM.rightHip, a, phases.top);
  const xFactor = new Float64Array(n);
  for (let f = 0; f < n; f++) xFactor[f] = shoulderTurn[f] - hipTurn[f];

  return { clubSpeed, handSpeed, headDx, headDy, hipDepth, spineAngle, shoulderTurn, hipTurn, xFactor };
}

/** 以 3D 世界座標計算左右點連線繞垂直軸的旋轉角（相對準備姿勢，頂點時為正） */
function turnSeries(fd: FrameData, kL: number, kR: number, address: number, top: number): Float64Array {
  const n = fd.n;
  const out = new Float64Array(n);
  let prev = NaN;
  let offset = 0;
  for (let f = 0; f < n; f++) {
    const [lx, , lz] = lm3(fd, f, kL);
    const [rx, , rz] = lm3(fd, f, kR);
    let ang = (Math.atan2(rz - lz, rx - lx) * 180) / Math.PI;
    if (!Number.isNaN(prev)) {
      const d = ang + offset - prev;
      if (d > 180) offset -= 360;
      else if (d < -180) offset += 360;
    }
    ang += offset;
    prev = ang;
    out[f] = ang;
  }
  const base = out[address];
  for (let f = 0; f < n; f++) out[f] -= base;
  const sign = out[top] < 0 ? -1 : 1;
  for (let f = 0; f < n; f++) out[f] *= sign;
  return out;
}

export function computeMetrics(ctx: MetricContext, series: MetricSeries): Metrics {
  const { fd, phases, calibration, capture, W, H, clubLengthPx } = ctx;
  const { t, n } = fd;
  const { address: a, takeaway: tk, top, impact: imp } = phases;
  const ppm = calibration.pxPerMeter;
  const s = sides(capture.handedness);
  const hasClub = ctx.clubCoverage >= 0.3;

  const backswingSec = top > tk ? t[top] - t[tk] : null;
  const downswingSec = imp > top ? t[imp] - t[top] : null;
  const tempoRatio = backswingSec && downswingSec ? backswingSec / downswingSec : null;

  const maxIn = (v: Float64Array, i0: number, i1: number) => {
    let m = -Infinity;
    for (let f = Math.max(0, i0); f <= Math.min(n - 1, i1); f++) if (!Number.isNaN(v[f]) && v[f] > m) m = v[f];
    return m === -Infinity ? null : m;
  };
  const absMaxIn = (v: Float64Array, i0: number, i1: number) => {
    let m = 0;
    for (let f = Math.max(0, i0); f <= Math.min(n - 1, i1); f++) if (Math.abs(v[f]) > Math.abs(m)) m = v[f];
    return m;
  };

  const clubAddr = clubPt(fd, a, W, H);
  const handsAddr = handsCenter(fd, a, W, H);
  const handsTop = handsCenter(fd, top, W, H);
  const clubTop = clubPt(fd, top, W, H);

  let shaftPlaneAddressDeg: number | null = null;
  let shaftAngleTopDeg: number | null = null;
  let overTheTopPct: number | null = null;
  let pathIndicator: number | null = null;
  let pathLabel: Metrics['pathLabel'] = null;

  if (clubAddr) {
    shaftPlaneAddressDeg = angleFromHorizontal(clubAddr, handsAddr);
    if (clubTop) shaftAngleTopDeg = angleFromHorizontal(clubTop, handsTop);
  }
  if (hasClub && clubAddr && imp - top >= 4) {
    // 肩平面：球（準備時桿頭）→ 肩中心
    const shoulderAddr = shoulderCenter(fd, a, W, H);
    const dsLen = imp - top;
    let above = 0;
    let cnt = 0;
    for (let f = top + Math.round(dsLen * 0.3); f <= top + Math.round(dsLen * 0.7); f++) {
      const c = clubPt(fd, f, W, H);
      if (!c) continue;
      cnt++;
      if (signedDistAbove(c, clubAddr, shoulderAddr) > 0) above++;
    }
    overTheTopPct = cnt ? above / cnt : null;

    // 擊球前的接近路徑：桿頭相對桿身平面的上下位置
    let sum = 0;
    let c2 = 0;
    for (let f = top + Math.round(dsLen * 0.6); f < imp; f++) {
      const c = clubPt(fd, f, W, H);
      if (!c) continue;
      sum += signedDistAbove(c, clubAddr, handsAddr);
      c2++;
    }
    if (c2) {
      pathIndicator = -(sum / c2) / Math.max(clubLengthPx, 1);
      pathLabel = pathIndicator > 0.05 ? 'inToOut' : pathIndicator < -0.05 ? 'outToIn' : 'neutral';
    }
  }

  const spineAddressDeg = series.spineAngle[a];
  const spineImpactDeg = series.spineAngle[imp];

  const trailKnee = (f: number) => angle3(lm(fd, f, s.trailHip, W, H),lm(fd, f, s.trailKnee, W, H), lm(fd, f, s.trailAnkle, W, H));
  const leadArmTopDeg = angle3(lm(fd, top, s.leadShoulder, W, H), lm(fd, top, s.leadElbow, W, H), lm(fd, top, s.leadWrist, W, H));

  const num = (v: number) => (Number.isFinite(v) ? v : null);

  return {
    tempoRatio,
    backswingSec,
    downswingSec,
    clubSpeedMax: hasClub ? maxIn(series.clubSpeed, tk, Math.min(n - 1, imp + 3)) : null,
    clubSpeedImpact: hasClub ? maxIn(series.clubSpeed, imp - 2, imp) : null,
    handSpeedMax: maxIn(series.handSpeed, tk, imp),
    shaftPlaneAddressDeg,
    shaftAngleTopDeg,
    overTheTopPct,
    pathIndicator,
    pathLabel,
    spineAddressDeg: num(spineAddressDeg),
    spineImpactDeg: num(spineImpactDeg),
    spineChangeDeg: num(spineImpactDeg - spineAddressDeg),
    earlyExtensionCm: num(series.hipDepth[imp]),
    headDxMaxCm: num(absMaxIn(series.headDx, a, imp)),
    headDyMaxCm: num(absMaxIn(series.headDy, a, imp)),
    headDxImpactCm: num(series.headDx[imp]),
    headDyImpactCm: num(series.headDy[imp]),
    trailKneeAddressDeg: num(trailKnee(a)),
    trailKneeImpactDeg: num(trailKnee(imp)),
    leadArmTopDeg: num(leadArmTopDeg),
    shoulderTurnTopDeg: num(series.shoulderTurn[top]),
    hipTurnTopDeg: num(series.hipTurn[top]),
    xFactorTopDeg: num(series.xFactor[top]),
    handHeightTopCm: num(((handsAddr.y - handsTop.y) / ppm) * 100),
    clubTrackCoverage: ctx.clubCoverage,
  };
}
