import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Phases } from '../../types';

const COLORS = ['#90a4ae', '#29b6f6', '#ffa726', '#ef5350', '#66bb6a'];
const KEYS: (keyof Phases)[] = ['address', 'takeaway', 'top', 'impact', 'finish'];

interface Props {
  n: number;
  frame: number;
  phases: Phases;
  onSeek: (frame: number) => void;
}

export default function Timeline({ n, frame, phases, onSeek }: Props) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const pct = (f: number) => (n > 1 ? (f / (n - 1)) * 100 : 0);

  const seekAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    onSeek(Math.round(x * (n - 1)));
  };

  return (
    <div
      ref={ref}
      className="timeline"
      role="slider"
      aria-valuemin={0}
      aria-valuemax={n - 1}
      aria-valuenow={frame}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') onSeek(Math.max(0, frame - 1));
        if (e.key === 'ArrowRight') onSeek(Math.min(n - 1, frame + 1));
      }}
      onPointerDown={(e) => {
        dragging.current = true;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        seekAt(e.clientX);
      }}
      onPointerMove={(e) => dragging.current && seekAt(e.clientX)}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
    >
      {KEYS.map((k) => (
        <span key={k} className="mark" style={{ left: `${pct(phases[k])}%` }}>
          {k === 'address' || k === 'top' || k === 'impact' || k === 'finish' ? t(`phase.${k}`) : ''}
        </span>
      ))}
      <div className="track">
        {KEYS.slice(0, -1).map((k, i) => (
          <div
            key={k}
            className="seg"
            style={{ left: `${pct(phases[k])}%`, width: `${pct(phases[KEYS[i + 1]]) - pct(phases[k])}%`, background: COLORS[i + 1] }}
          />
        ))}
      </div>
      <div className="head" style={{ left: `${pct(frame)}%` }} />
    </div>
  );
}
