import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import uPlot from 'uplot';
import type { MetricSeries } from '../../core/metrics/computeMetrics';
import type { Phases } from '../../types';

interface ChartDef {
  title: string;
  series: { key: keyof MetricSeries; color: string }[];
}

const CHARTS: ChartDef[] = [
  {
    title: 'speed',
    series: [
      { key: 'clubSpeed', color: '#f5a623' },
      { key: 'handSpeed', color: '#2a9df4' },
    ],
  },
  {
    title: 'displacement',
    series: [
      { key: 'headDx', color: '#e0524a' },
      { key: 'headDy', color: '#f08a80' },
      { key: 'hipDepth', color: '#9b59b6' },
    ],
  },
  {
    title: 'rotation',
    series: [
      { key: 'shoulderTurn', color: '#f39c12' },
      { key: 'hipTurn', color: '#8e44ad' },
      { key: 'xFactor', color: '#16a085' },
    ],
  },
  {
    title: 'posture',
    series: [{ key: 'spineAngle', color: '#27ae60' }],
  },
];

interface Props {
  t: Float64Array;
  series: MetricSeries;
  phases: Phases;
  frame: number;
  onSeek: (frame: number) => void;
}

export default function Charts(props: Props) {
  return (
    <div className="stack">
      {CHARTS.map((c) => (
        <Chart key={c.title} def={c} {...props} />
      ))}
    </div>
  );
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function Chart({ def, t, series, phases, frame, onSeek }: Props & { def: ChartDef }) {
  const { t: tr } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const frameRef = useRef(frame);
  const seekRef = useRef(onSeek);
  seekRef.current = onSeek;

  useEffect(() => {
    const el = box.current!;
    const text = cssVar('--text-2');
    const grid = cssVar('--border');
    const accent = cssVar('--accent');
    const toNull = (a: Float64Array) => Array.from(a, (v) => (Number.isFinite(v) ? v : null));
    const data: uPlot.AlignedData = [Array.from(t), ...def.series.map((s) => toNull(series[s.key]))];
    const phaseIdx = [phases.address, phases.top, phases.impact, phases.finish];

    const opts: uPlot.Options = {
      width: el.clientWidth,
      height: 180,
      title: tr(`chart.${def.title}`),
      scales: { x: { time: false } },
      legend: { live: true },
      cursor: { drag: { x: false, y: false }, points: { size: 6 } },
      axes: [
        { stroke: text, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, values: (_u, v) => v.map((x) => `${x.toFixed(2)}s`) },
        { stroke: text, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, size: 44 },
      ],
      series: [{ label: 's', value: (_u, v) => (v == null ? '-' : v.toFixed(3)) }, ...def.series.map((s) => ({
        label: tr(`chart.${s.key}`),
        stroke: s.color,
        width: 2,
        spanGaps: false,
        value: (_u: uPlot, v: number | null) => (v == null ? '-' : v.toFixed(1)),
      }))],
      hooks: {
        draw: [
          (u) => {
            const ctx = u.ctx;
            const { top, height } = u.bbox;
            ctx.save();
            ctx.lineWidth = 1 * devicePixelRatio;
            ctx.setLineDash([4 * devicePixelRatio, 4 * devicePixelRatio]);
            ctx.strokeStyle = text;
            for (const i of phaseIdx) {
              const x = Math.round(u.valToPos(t[i], 'x', true));
              ctx.beginPath();
              ctx.moveTo(x, top);
              ctx.lineTo(x, top + height);
              ctx.stroke();
            }
            ctx.setLineDash([]);
            ctx.strokeStyle = accent;
            ctx.lineWidth = 2 * devicePixelRatio;
            const x = Math.round(u.valToPos(t[frameRef.current], 'x', true));
            ctx.beginPath();
            ctx.moveTo(x, top);
            ctx.lineTo(x, top + height);
            ctx.stroke();
            ctx.restore();
          },
        ],
      },
    };
    const u = new uPlot(opts, data, el);
    plot.current = u;
    const onClick = () => {
      const idx = u.cursor.idx;
      if (idx != null) seekRef.current(idx);
    };
    u.over.addEventListener('click', onClick);
    const ro = new ResizeObserver(() => u.setSize({ width: el.clientWidth, height: 180 }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
      plot.current = null;
    };
  }, [def, t, series, phases, tr]);

  useEffect(() => {
    frameRef.current = frame;
    plot.current?.redraw(false, false);
  }, [frame]);

  return <div ref={box} className="chart-box" />;
}
