import { useTranslation } from 'react-i18next';
import { LAYERS } from '../../overlay/layers';
import { PRESETS } from '../../overlay/renderer';
import { useSettings } from '../../store/settings';
import type { ViewAngle } from '../../types';

interface Props {
  view: ViewAngle;
  onClose: () => void;
}

export default function LayerPanel({ view, onClose }: Props) {
  const { t } = useTranslation();
  const { layers, trailMode, setLayer, applyPreset, setTrailMode } = useSettings();

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet" role="dialog" aria-label={t('viewer.layers')}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong>{t('viewer.layers')}</strong>
          <button className="btn small" onClick={onClose}>
            {t('viewer.done')}
          </button>
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <span>{t('viewer.presets')}</span>
          <div className="row">
            {[...Object.keys(PRESETS), 'none'].map((p) => (
              <button key={p} className="btn small" onClick={() => applyPreset(p)}>
                {t(`preset.${p}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="segmented" style={{ margin: '12px 0' }}>
          <button aria-pressed={trailMode === 'toNow'} onClick={() => setTrailMode('toNow')}>
            {t('viewer.trailToNow')}
          </button>
          <button aria-pressed={trailMode === 'full'} onClick={() => setTrailMode('full')}>
            {t('viewer.trailFull')}
          </button>
        </div>
        {LAYERS.filter((l) => l.views.includes(view)).map((l) => {
          const s = layers[l.id];
          return (
            <div key={l.id} className="layer-row">
              <label>
                <input type="checkbox" className="switch" checked={s.enabled} onChange={(e) => setLayer(l.id, { enabled: e.target.checked })} />
                {t(`layer.${l.id}`)}
              </label>
              <input type="color" value={s.color} aria-label="color" onChange={(e) => setLayer(l.id, { color: e.target.value })} />
              <input
                type="range"
                min={0.2}
                max={1}
                step={0.05}
                value={s.opacity}
                aria-label="opacity"
                onChange={(e) => setLayer(l.id, { opacity: Number(e.target.value) })}
              />
            </div>
          );
        })}
      </div>
    </>
  );
}
