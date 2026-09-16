import { create } from 'zustand';
import { DEFAULT_CLUB_LENGTH_CM } from '../core/calibration/calibration';
import type { PoseModel } from '../core/inference/pose';
import { defaultLayerSettings, PRESETS, type LayerSettings, type TrailMode } from '../overlay/renderer';
import type { LayerId, LayerStyle } from '../overlay/types';
import { getSetting, setSetting } from '../storage/db';
import type { CaptureInfo } from '../types';

export interface SettingsState {
  loaded: boolean;
  layers: LayerSettings;
  trailMode: TrailMode;
  poseModel: PoseModel;
  captureDefaults: CaptureInfo;
  load: () => Promise<void>;
  setLayer: (id: LayerId, patch: Partial<LayerStyle>) => void;
  applyPreset: (name: keyof typeof PRESETS | 'none') => void;
  setTrailMode: (m: TrailMode) => void;
  setPoseModel: (m: PoseModel) => void;
  setCaptureDefaults: (c: CaptureInfo) => void;
}

const DEFAULT_CAPTURE: CaptureInfo = {
  viewAngle: 'dtl',
  handedness: 'right',
  heightCm: 175,
  clubType: 'iron',
  clubLengthCm: DEFAULT_CLUB_LENGTH_CM.iron,
};

export const useSettings = create<SettingsState>((set, get) => ({
  loaded: false,
  layers: defaultLayerSettings(),
  trailMode: 'toNow',
  poseModel: 'full',
  captureDefaults: DEFAULT_CAPTURE,
  load: async () => {
    const [layers, trailMode, poseModel, captureDefaults] = await Promise.all([
      getSetting<Partial<LayerSettings>>('layers', {}),
      getSetting<TrailMode>('trailMode', 'toNow'),
      getSetting<PoseModel>('poseModel', 'full'),
      getSetting<CaptureInfo>('captureDefaults', DEFAULT_CAPTURE),
    ]);
    const merged = defaultLayerSettings();
    for (const k of Object.keys(merged) as LayerId[]) if (layers[k]) merged[k] = { ...merged[k], ...layers[k] };
    set({ loaded: true, layers: merged, trailMode, poseModel, captureDefaults: { ...DEFAULT_CAPTURE, ...captureDefaults } });
  },
  setLayer: (id, patch) => {
    const layers = { ...get().layers, [id]: { ...get().layers[id], ...patch } };
    set({ layers });
    void setSetting('layers', layers);
  },
  applyPreset: (name) => {
    const on = new Set(name === 'none' ? [] : PRESETS[name]);
    const layers = { ...get().layers };
    for (const k of Object.keys(layers) as LayerId[]) layers[k] = { ...layers[k], enabled: on.has(k) };
    set({ layers });
    void setSetting('layers', layers);
  },
  setTrailMode: (trailMode) => {
    set({ trailMode });
    void setSetting('trailMode', trailMode);
  },
  setPoseModel: (poseModel) => {
    set({ poseModel });
    void setSetting('poseModel', poseModel);
  },
  setCaptureDefaults: (captureDefaults) => {
    set({ captureDefaults });
    void setSetting('captureDefaults', captureDefaults);
  },
}));
