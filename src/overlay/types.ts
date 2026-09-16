import type { AnalysisResult } from '../core/pipeline';
import type { CaptureInfo, FrameData, ViewAngle } from '../types';

export type LayerId =
  | 'skeleton'
  | 'clubPath'
  | 'clubShaft'
  | 'handPath'
  | 'headPath'
  | 'hipPath'
  | 'spineAngle'
  | 'swingPlane'
  | 'shoulderLine'
  | 'hipLine'
  | 'phaseMarkers'
  | 'rotationGauge'
  | 'grid';

export interface LayerStyle {
  enabled: boolean;
  color: string;
  width: number;
  opacity: number;
}

export interface DrawContext {
  ctx: CanvasRenderingContext2D;
  fd: FrameData;
  frame: number;
  /** 影片像素寬高（旋轉後原解析度） */
  W: number;
  H: number;
  /** 影片像素 → CSS 像素的縮放 */
  scale: number;
  /** 以 CSS 像素換算成影片像素的線寬 */
  px: (cssPx: number) => number;
  result: AnalysisResult;
  capture: CaptureInfo;
  style: LayerStyle;
  /** 軌跡繪製範圍 */
  from: number;
  to: number;
  t: (key: string) => string;
}

export interface LayerDef {
  id: LayerId;
  defaultStyle: Omit<LayerStyle, 'enabled'>;
  defaultOn: boolean;
  views: ViewAngle[];
  /** 繪製於畫面座標（不套用影片縮放），例如儀表 */
  screenSpace?: boolean;
  draw: (dc: DrawContext) => void;
}
