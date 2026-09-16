interface Props {
  min: number;
  max: number;
  step: number;
  value: [number, number];
  onChange: (v: [number, number], moved: 0 | 1) => void;
}

export default function RangeDual({ min, max, step, value, onChange }: Props) {
  const pct = (v: number) => ((v - min) / (max - min || 1)) * 100;
  return (
    <div className="range-dual">
      <div className="rail" />
      <div className="fill" style={{ left: `${pct(value[0])}%`, width: `${pct(value[1]) - pct(value[0])}%` }} />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value[0]}
        onChange={(e) => onChange([Math.min(Number(e.target.value), value[1] - step), value[1]], 0)}
      />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value[1]}
        onChange={(e) => onChange([value[0], Math.max(Number(e.target.value), value[0] + step)], 1)}
      />
    </div>
  );
}
