import { describe, expect, it } from 'vitest';
import { CAND_STRIDE, CLUB_CANDS, ClubSource, type CaptureInfo } from '../types';
import { decodeFrames, encodeFrames, cloneFrames } from '../storage/frameCodec';
import { calibrateByHeight } from './calibration/calibration';
import { angle3, signedDistAbove } from './landmarks';
import { detectPhases } from './phases/detectPhases';
import { analyze } from './pipeline';
import { rng, SYN, syntheticSwing } from './testing/synthetic';
import { trackClub } from './tracking/clubTracker';
import { fillGapsLinear, Kalman1D, OneEuroFilter, rtsSmoothCA, zeroPhaseOneEuro } from './tracking/filters';
import { smoothPose } from './tracking/poseSmoothing';
import { LM } from './landmarks';
import { parseYolo } from './inference/clubDetector';
import { catmullRom } from '../overlay/layers';

const W = 1000;
const H = 1000;
const frameOf = (t: number) => Math.round(t * SYN.fps);
const capture: CaptureInfo = { viewAngle: 'dtl', handedness: 'right', heightCm: 175, clubType: 'iron', clubLengthCm: 94 };

describe('filters', () => {
  it('fillGapsLinear 內插與頭尾延伸', () => {
    const t = Float64Array.from([0, 1, 2, 3, 4]);
    const v = Float64Array.from([NaN, 1, NaN, 3, NaN]);
    expect(Array.from(fillGapsLinear(v, t))).toEqual([1, 1, 2, 3, 3]);
  });

  it('zeroPhaseOneEuro 保持常數與無相位延遲', () => {
    const n = 100;
    const t = Float64Array.from({ length: n }, (_, i) => i / 60);
    const c = zeroPhaseOneEuro(new Float64Array(n).fill(5), t, 1, 0.1);
    expect(Math.max(...c.map((x) => Math.abs(x - 5)))).toBeLessThan(1e-9);
    const ramp = Float64Array.from(t, (x) => x);
    const r = zeroPhaseOneEuro(ramp, t, 1, 0.1);
    expect(Math.abs(r[50] - ramp[50])).toBeLessThan(0.01);
  });

  it('rtsSmoothCA 在缺口中依前後慣性推估（等加速度運動）', () => {
    const n = 120;
    const t = Float64Array.from({ length: n }, (_, i) => i / 30);
    const truth = (x: number) => 2 + 3 * x + 4 * x * x;
    const rand = rng(3);
    const z = Float64Array.from(t, (x, i) => (i >= 50 && i < 70 ? NaN : truth(x) + (rand() - 0.5) * 0.02));
    const res = rtsSmoothCA(z, new Float64Array(n).fill(0.01 ** 2), t, 1);
    let max = 0;
    for (let i = 50; i < 70; i++) max = Math.max(max, Math.abs(res.x[i] - truth(t[i])));
    expect(max).toBeLessThan(0.05);
    expect(res.v[60]).toBeCloseTo(3 + 8 * t[60], 0);
  });

  it('Kalman1D 追蹤等速運動', () => {
    const k = new Kalman1D(1, 0.01);
    k.init(0);
    for (let i = 1; i <= 30; i++) {
      k.predict(0.1);
      k.update(i * 0.5);
    }
    expect(k.x[0]).toBeCloseTo(15, 0);
    expect(k.x[1]).toBeCloseTo(5, 0);
  });
});

describe('geometry', () => {
  it('catmullRom 通過兩端點且落在中間', () => {
    const p = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 1 }, { x: 3, y: 3 }];
    const a = catmullRom(p[0], p[1], p[2], p[3], 0);
    const b = catmullRom(p[0], p[1], p[2], p[3], 1);
    const m = catmullRom(p[0], p[1], p[2], p[3], 0.5);
    expect(a.x).toBeCloseTo(1);
    expect(a.y).toBeCloseTo(0);
    expect(b.x).toBeCloseTo(2);
    expect(b.y).toBeCloseTo(1);
    expect(m.x).toBeGreaterThan(1);
    expect(m.x).toBeLessThan(2);
  });

  it('angle3', () => {
    expect(angle3({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(90);
  });
  it('signedDistAbove：畫面上方為正（與線方向無關）', () => {
    const p = { x: 0.5, y: -1 };
    expect(signedDistAbove(p, { x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(1);
    expect(signedDistAbove(p, { x: 1, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(1);
  });
});

describe('smoothPose', () => {
  it('前導手腕長時間被遮住（低可見度）時不產生 NaN，階段仍正確', () => {
    const fd = syntheticSwing();
    // 0–1.8 秒左手腕可見度極低，且原始座標帶有雜訊
    const rand = rng(7);
    for (let f = 0; f < frameOf(1.8); f++) {
      const o = (f * 33 + LM.leftWrist) * 4;
      fd.pose2d[o] += (rand() - 0.5) * 0.02;
      fd.pose2d[o + 3] = 0.03;
    }
    // 開頭 5 格完全沒偵測到人物
    for (let f = 0; f < 5; f++) for (let k = 0; k < 33; k++) {
      const o = (f * 33 + k) * 4;
      fd.pose2d.fill(NaN, o, o + 3);
      fd.pose2d[o + 3] = 0;
    }
    smoothPose(fd);
    expect(fd.pose2d.some((v, i) => i % 4 < 2 && Number.isNaN(v))).toBe(false);
    const p = detectPhases(fd, { W, H, useClub: false })!;
    expect(Math.abs(p.top - frameOf(SYN.topT))).toBeLessThanOrEqual(3);
    expect(Math.abs(p.impact - frameOf(SYN.impactT))).toBeLessThanOrEqual(3);
  });

  it('OneEuroFilter 略過 NaN 且不汙染後續輸出', () => {
    const f = new OneEuroFilter();
    f.filter(1, 0);
    expect(Number.isNaN(f.filter(NaN, 0.1))).toBe(true);
    expect(f.filter(1, 0.2)).toBeCloseTo(1);
  });
});

describe('detectPhases', () => {
  it('合成揮桿的階段', () => {
    const fd = syntheticSwing();
    const p = detectPhases(fd, { W, H, useClub: false })!;
    expect(p.top).toBeGreaterThanOrEqual(frameOf(SYN.topT) - 2);
    expect(p.top).toBeLessThanOrEqual(frameOf(SYN.topT) + 2);
    expect(Math.abs(p.impact - frameOf(SYN.impactT))).toBeLessThanOrEqual(2);
    expect(p.address).toBeLessThanOrEqual(frameOf(SYN.takeawayT) + 3);
    expect(p.takeaway).toBeGreaterThanOrEqual(frameOf(SYN.takeawayT));
    expect(p.takeaway).toBeLessThanOrEqual(frameOf(SYN.takeawayT) + 8);
    expect(p.finish).toBeGreaterThanOrEqual(frameOf(SYN.finishT) - 6);
    expect(p.finish).toBeLessThanOrEqual(frameOf(SYN.finishT) + 15);
  });
});

describe('trackClub', () => {
  it('雜訊、缺漏與離群值下仍接近真實位置', () => {
    const fd = syntheticSwing();
    const truth = Float32Array.from(fd.clubRaw);
    const rand = rng(42);
    for (let f = 0; f < fd.n; f++) {
      const r = rand();
      if (r < 0.25) {
        fd.clubRaw[f * 3] = NaN;
        fd.clubRaw[f * 3 + 1] = NaN;
        fd.clubRaw[f * 3 + 2] = 0;
        fd.clubRawSource[f] = ClubSource.None;
      } else if (r < 0.3) {
        // 離群值：畫面另一側
        fd.clubRaw[f * 3] = 0.05;
        fd.clubRaw[f * 3 + 1] = 0.05;
      } else {
        fd.clubRaw[f * 3] += (rand() - 0.5) * 0.006;
        fd.clubRaw[f * 3 + 1] += (rand() - 0.5) * 0.006;
      }
    }
    const res = trackClub(fd, { W, H, handedness: 'right', fallbackLengthPx: 250 });
    expect(res.lengthPx).toBeGreaterThan(260);
    expect(res.lengthPx).toBeLessThan(340);
    let sum = 0;
    let max = 0;
    for (let f = 0; f < fd.n; f++) {
      const e = Math.hypot(res.club[f * 2] - truth[f * 3], res.club[f * 2 + 1] - truth[f * 3 + 1]);
      sum += e;
      max = Math.max(max, e);
    }
    expect(sum / fd.n).toBeLessThan(0.01);
    expect(max).toBeLessThan(0.06);
    expect(res.coverage).toBeGreaterThan(0.7);
  });

  it('下桿整段模糊（0.25 秒無偵測）時依手臂旋轉進度內插', () => {
    const fd = syntheticSwing();
    const truth = Float32Array.from(fd.clubRaw);
    for (let f = frameOf(2.03); f <= frameOf(2.27); f++) {
      fd.clubRaw.set([NaN, NaN, 0], f * 3);
      fd.clubRawSource[f] = ClubSource.None;
    }
    // 其餘格以桿身偵測來源提供
    for (let f = 0; f < fd.n; f++) if (fd.clubRawSource[f] === ClubSource.Model) fd.clubRawSource[f] = ClubSource.Shaft;
    const res = trackClub(fd, { W, H, handedness: 'right', fallbackLengthPx: 300 });
    let max = 0;
    for (let f = frameOf(2.03); f <= frameOf(2.27); f++) {
      expect(res.clubSource[f]).toBe(ClubSource.Predicted);
      max = Math.max(max, Math.hypot(res.club[f * 2] - truth[f * 3], res.club[f * 2 + 1] - truth[f * 3 + 1]));
    }
    expect(max).toBeLessThan(0.03);
    expect(res.coverage).toBe(1);
  });

  it('多候選：信心值更高的干擾直線不會讓路徑跳走', () => {
    const fd = syntheticSwing();
    const truth = Float32Array.from(fd.clubRaw);
    const rand = rng(11);
    const cands = new Float32Array(fd.n * CLUB_CANDS * CAND_STRIDE).fill(NaN);
    for (let f = 0; f < fd.n; f++) {
      const o = f * CLUB_CANDS * CAND_STRIDE;
      const hx = fd.pose2d[(f * 33 + 15) * 4];
      const hy = fd.pose2d[(f * 33 + 15) * 4 + 1];
      // 三成的格有一條信心值更高的錯誤直線（隨機方向）
      const distract = rand() < 0.3;
      const a = rand() * Math.PI * 2;
      const wrong = [hx + Math.cos(a) * 0.3, hy + Math.sin(a) * 0.3, 0.9, 0];
      const right = [truth[f * 3], truth[f * 3 + 1], 0.6, 0];
      cands.set(distract ? [...wrong, 0, ...right, 0] : [...right, 0], o);
      fd.clubRawSource[f] = ClubSource.Shaft;
    }
    fd.clubCands = cands;
    const res = trackClub(fd, { W, H, handedness: 'right', fallbackLengthPx: 300 });
    let sum = 0;
    for (let f = 0; f < fd.n; f++) sum += Math.hypot(res.club[f * 2] - truth[f * 3], res.club[f * 2 + 1] - truth[f * 3 + 1]);
    expect(sum / fd.n).toBeLessThan(0.01);
  });

  it('有雜訊時輸出軌跡平滑（二階差分遠小於量測）', () => {
    const fd = syntheticSwing();
    const rand = rng(21);
    const jag = (arr: ArrayLike<number>, stride: number) => {
      let sum = 0;
      for (let f = 1; f < fd.n - 1; f++) {
        const ax = arr[(f + 1) * stride] - 2 * arr[f * stride] + arr[(f - 1) * stride];
        const ay = arr[(f + 1) * stride + 1] - 2 * arr[f * stride + 1] + arr[(f - 1) * stride + 1];
        sum += Math.hypot(ax, ay);
      }
      return sum / (fd.n - 2);
    };
    const clean = jag(fd.clubRaw, 3);
    for (let f = 0; f < fd.n; f++) {
      fd.clubRaw[f * 3] += (rand() - 0.5) * 0.01;
      fd.clubRaw[f * 3 + 1] += (rand() - 0.5) * 0.01;
    }
    const noisy = jag(fd.clubRaw, 3);
    const res = trackClub(fd, { W, H, handedness: 'right', fallbackLengthPx: 300 });
    const out = jag(res.club, 2);
    expect(out).toBeLessThan(noisy * 0.5);
    expect(out).toBeLessThan(clean * 2 + 0.002);
  });

  it('無偵測資料時以手部方向估算', () => {
    const fd = syntheticSwing();
    fd.clubRawSource.fill(ClubSource.None);
    fd.clubRaw.fill(NaN);
    const res = trackClub(fd, { W, H, handedness: 'right', fallbackLengthPx: 300 });
    expect(res.coverage).toBe(0);
    expect(res.clubSource.every((s) => s === ClubSource.HandEstimate)).toBe(true);
    const f = frameOf(SYN.topT);
    expect(Number.isFinite(res.club[f * 2])).toBe(true);
  });
});

describe('calibration & metrics', () => {
  it('身高換算', () => {
    const fd = syntheticSwing();
    const cal = calibrateByHeight(fd, 0, 175, W, H)!;
    const leg = Math.hypot(20, 150) + Math.hypot(20, 150);
    const torso = Math.hypot(20, 180);
    expect(cal.pxPerMeter).toBeCloseTo((leg + torso) / (0.781 * 1.75), 0);
  });

  it('analyze 產生合理指標', () => {
    const fd = syntheticSwing();
    const res = analyze(fd, capture, W, H)!;
    const m = res.metrics;
    expect(m.tempoRatio!).toBeGreaterThan(2.6);
    expect(m.tempoRatio!).toBeLessThan(3.6);
    expect(m.shoulderTurnTopDeg!).toBeGreaterThan(80);
    expect(m.shoulderTurnTopDeg!).toBeLessThan(95);
    expect(m.hipTurnTopDeg!).toBeGreaterThan(38);
    expect(m.hipTurnTopDeg!).toBeLessThan(48);
    expect(m.xFactorTopDeg!).toBeGreaterThan(38);
    expect(Math.abs(m.earlyExtensionCm!)).toBeLessThan(0.5);
    expect(Math.abs(m.headDyMaxCm!)).toBeLessThan(0.5);
    expect(m.clubTrackCoverage).toBeGreaterThan(0.95);
    // 桿頭最大速度：角速度峰值約 1000°/s × 半徑 0.5（正規化）→ 像素 / ppm
    const expected = ((1000 * Math.PI) / 180) * (SYN.armR + SYN.clubL) * W / res.calibration.pxPerMeter;
    expect(m.clubSpeedMax!).toBeGreaterThan(expected * 0.8);
    expect(m.clubSpeedMax!).toBeLessThan(expected * 1.05);
    expect(res.series.clubSpeed.length).toBe(fd.n);
  });
});

describe('frameCodec', () => {
  it('壓縮後可完整還原', async () => {
    const fd = syntheticSwing();
    const blob = await encodeFrames(fd);
    const back = await decodeFrames(blob);
    expect(back.n).toBe(fd.n);
    expect(Array.from(back.pose2d.slice(0, 200))).toEqual(Array.from(fd.pose2d.slice(0, 200)));
    expect(back.t[100]).toBe(fd.t[100]);
    expect(back.clubRawSource[5]).toBe(fd.clubRawSource[5]);
    const c = cloneFrames(fd);
    c.t[0] = 99;
    expect(fd.t[0]).toBe(0);
  });
});

describe('parseYolo', () => {
  it('解析 [1, 4+nc, N] 輸出', () => {
    const N = 3;
    const nc = 2;
    const data = new Float32Array((4 + nc) * N);
    // anchor 1：cx=100, cy=200, class0 = 0.9
    data[1] = 100;
    data[N + 1] = 200;
    data[4 * N + 1] = 0.9;
    data[5 * N + 2] = 0.8; // anchor 2 是另一類別
    const out = parseYolo(data, [1, 4 + nc, N], 0, 0.5);
    expect(out).toEqual([{ x: 100, y: 200, conf: expect.closeTo(0.9, 5) }]);
  });
});
