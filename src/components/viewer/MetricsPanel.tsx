import { useTranslation } from 'react-i18next';
import { clubPt, handsCenter, hipCenter, lm, LM, sides, type Pt } from '../../core/landmarks';
import type { AnalysisResult } from '../../core/pipeline';
import type { CaptureInfo, FrameData, Metrics, Phases } from '../../types';

type Grade = 'good' | 'warn' | 'bad' | undefined;

interface Item {
  key: keyof Metrics;
  unit?: 'cm' | 'sec' | 'deg' | 'mps' | 'pct' | 'ratio';
  digits?: number;
  grade?: (v: number) => Grade;
}

const band = (v: number, good: number, warn: number): Grade => (v <= good ? 'good' : v <= warn ? 'warn' : 'bad');

const GROUPS: { title: string; items: Item[] }[] = [
  {
    title: 'groupTempo',
    items: [
      { key: 'tempoRatio', unit: 'ratio', digits: 1, grade: (v) => band(Math.abs(v - 3), 0.5, 1) },
      { key: 'backswingSec', unit: 'sec', digits: 2 },
      { key: 'downswingSec', unit: 'sec', digits: 2 },
    ],
  },
  {
    title: 'groupClub',
    items: [
      { key: 'clubSpeedMax', unit: 'mps', digits: 1 },
      { key: 'clubSpeedImpact', unit: 'mps', digits: 1 },
      { key: 'handSpeedMax', unit: 'mps', digits: 1 },
      { key: 'pathLabel' },
      { key: 'overTheTopPct', unit: 'pct', digits: 0, grade: (v) => band(v, 0.2, 0.5) },
      { key: 'shaftPlaneAddressDeg', unit: 'deg', digits: 0 },
      { key: 'shaftAngleTopDeg', unit: 'deg', digits: 0 },
      { key: 'clubTrackCoverage', unit: 'pct', digits: 0, grade: (v) => (v >= 0.7 ? 'good' : v >= 0.3 ? 'warn' : 'bad') },
    ],
  },
  {
    title: 'groupBody',
    items: [
      { key: 'spineAddressDeg', unit: 'deg', digits: 0 },
      { key: 'spineImpactDeg', unit: 'deg', digits: 0 },
      { key: 'spineChangeDeg', unit: 'deg', digits: 1, grade: (v) => band(-v, 5, 10) },
      { key: 'earlyExtensionCm', unit: 'cm', digits: 1, grade: (v) => band(v, 3, 6) },
      { key: 'headDxMaxCm', unit: 'cm', digits: 1, grade: (v) => band(Math.abs(v), 5, 10) },
      { key: 'headDyMaxCm', unit: 'cm', digits: 1, grade: (v) => band(Math.abs(v), 5, 10) },
      { key: 'shoulderTurnTopDeg', unit: 'deg', digits: 0 },
      { key: 'hipTurnTopDeg', unit: 'deg', digits: 0 },
      { key: 'xFactorTopDeg', unit: 'deg', digits: 0 },
      { key: 'leadArmTopDeg', unit: 'deg', digits: 0, grade: (v) => (v >= 160 ? 'good' : v >= 140 ? 'warn' : 'bad') },
      { key: 'trailKneeAddressDeg', unit: 'deg', digits: 0 },
      { key: 'trailKneeImpactDeg', unit: 'deg', digits: 0 },
      { key: 'handHeightTopCm', unit: 'cm', digits: 0 },
    ],
  },
];

interface Props {
  result: AnalysisResult;
  fd: FrameData;
  capture: CaptureInfo;
  W: number;
  H: number;
}

export default function MetricsPanel({ result, fd, capture, W, H }: Props) {
  const { t } = useTranslation();
  const m = result.metrics;

  const fmt = (it: Item): { text: string; unit: string; grade: Grade } => {
    const raw = m[it.key];
    if (raw == null) return { text: t('common.none'), unit: '', grade: undefined };
    if (it.key === 'pathLabel') return { text: t(`metric.${raw as string}`), unit: '', grade: undefined };
    const v = raw as number;
    const grade = it.grade?.(v);
    switch (it.unit) {
      case 'pct':
        return { text: (v * 100).toFixed(it.digits ?? 0), unit: '%', grade };
      case 'ratio':
        return { text: `${v.toFixed(it.digits ?? 1)} : 1`, unit: '', grade };
      case 'mps':
        return { text: v.toFixed(it.digits ?? 1), unit: `m/s · ${(v * 3.6).toFixed(0)} km/h`, grade };
      default:
        return { text: v.toFixed(it.digits ?? 1), unit: it.unit ? t(`common.${it.unit}`) : '', grade };
    }
  };

  const clubEstimated = m.clubTrackCoverage < 0.3;

  return (
    <div className="stack">
      {clubEstimated && <div className="notice warn">{t('viewer.lowCoverage', { pct: Math.round(m.clubTrackCoverage * 100) })}</div>}
      <Advice m={m} />
      {GROUPS.map((g) => (
        <section key={g.title} className="stack" style={{ gap: 8 }}>
          <strong>{t(`metric.${g.title}`)}</strong>
          <div className="metric-grid">
            {g.items.map((it) => {
              const f = fmt(it);
              return (
                <div key={it.key} className={`metric ${f.grade ?? ''}`}>
                  <div className="label">{t(`metric.${it.key}`)}</div>
                  <div className="value">
                    {f.text}
                    {f.unit && <small>{f.unit}</small>}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
      <section className="stack" style={{ gap: 8 }}>
        <strong>{t('metric.groupCompare')}</strong>
        <CompareTable fd={fd} phases={result.phases} ppm={result.calibration.pxPerMeter} capture={capture} W={W} H={H} />
      </section>
      <p className="muted">{t('metric.disclaimer')}</p>
    </div>
  );
}

function Advice({ m }: { m: Metrics }) {
  const { t } = useTranslation();
  const tips: { grade: Grade; text: string }[] = [];
  if (m.tempoRatio != null && Math.abs(m.tempoRatio - 3) > 0.5)
    tips.push({ grade: Math.abs(m.tempoRatio - 3) > 1 ? 'bad' : 'warn', text: t('advice.tempo', { v: `${m.tempoRatio.toFixed(1)}:1` }) });
  if (m.earlyExtensionCm != null && m.earlyExtensionCm > 3)
    tips.push({ grade: m.earlyExtensionCm > 6 ? 'bad' : 'warn', text: t('advice.earlyExtension', { v: m.earlyExtensionCm.toFixed(1) }) });
  if (m.headDyMaxCm != null && Math.abs(m.headDyMaxCm) > 5)
    tips.push({ grade: Math.abs(m.headDyMaxCm) > 10 ? 'bad' : 'warn', text: t('advice.head', { v: Math.abs(m.headDyMaxCm).toFixed(1) }) });
  if (m.spineChangeDeg != null && m.spineChangeDeg < -5)
    tips.push({ grade: m.spineChangeDeg < -10 ? 'bad' : 'warn', text: t('advice.spine', { v: Math.abs(m.spineChangeDeg).toFixed(0) }) });
  if (m.overTheTopPct != null && m.overTheTopPct > 0.2)
    tips.push({ grade: m.overTheTopPct > 0.5 ? 'bad' : 'warn', text: t('advice.overTheTop', { v: Math.round(m.overTheTopPct * 100) }) });
  if (m.leadArmTopDeg != null && m.leadArmTopDeg < 150) tips.push({ grade: 'warn', text: t('advice.leadArm', { v: m.leadArmTopDeg.toFixed(0) }) });
  if (!tips.length) return null;
  return (
    <div className="stack" style={{ gap: 6 }}>
      {tips.map((tip) => (
        <div key={tip.text} className={`metric ${tip.grade}`} style={{ fontSize: 14 }}>
          {tip.text}
        </div>
      ))}
    </div>
  );
}

function CompareTable({ fd, phases, ppm, capture, W, H }: { fd: FrameData; phases: Phases; ppm: number; capture: CaptureInfo; W: number; H: number }) {
  const { t } = useTranslation();
  const toBall = sides(capture.handedness).toBall;
  const cols: (keyof Phases)[] = ['address', 'top', 'impact', 'finish'];
  const rows: { key: string; get: (f: number) => Pt | null }[] = [
    { key: 'head', get: (f) => lm(fd, f, LM.nose, W, H) },
    { key: 'hip', get: (f) => hipCenter(fd, f, W, H) },
    { key: 'hands', get: (f) => handsCenter(fd, f, W, H) },
    { key: 'club', get: (f) => clubPt(fd, f, W, H) },
  ];
  const cell = (get: (f: number) => Pt | null, f: number) => {
    const p0 = get(phases.address);
    const p = get(f);
    if (!p0 || !p) return t('common.none');
    const dx = (((p.x - p0.x) * toBall) / ppm) * 100;
    const dy = ((p0.y - p.y) / ppm) * 100;
    return `${dx >= 0 ? '+' : ''}${dx.toFixed(0)} / ${dy >= 0 ? '+' : ''}${dy.toFixed(0)}`;
  };
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>{t('metric.part')}</th>
            {cols.map((c) => (
              <th key={c}>{t(`phase.${c}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{t(`metric.${r.key}`)}</td>
              {cols.map((c) => (
                <td key={c}>{cell(r.get, phases[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ margin: '4px 0 0' }}>
        {t('metric.compareUnit')}
      </p>
    </div>
  );
}
