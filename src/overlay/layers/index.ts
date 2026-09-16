import {
  LM,
  POSE_CONNECTIONS,
  angleFromVertical,
  clubPt,
  handsCenter,
  hipCenter,
  lm,
  shoulderCenter,
  vis,
  type Pt,
} from '../../core/landmarks';
import { ClubSource, type Phases } from '../../types';
import type { DrawContext, LayerDef, LayerId } from '../types';

const all = ['dtl', 'faceOn'] as const;

function withStyle(dc: DrawContext, fn: (ctx: CanvasRenderingContext2D) => void) {
  const { ctx, style } = dc;
  ctx.save();
  ctx.globalAlpha = style.opacity;
  ctx.strokeStyle = style.color;
  ctx.fillStyle = style.color;
  ctx.lineWidth = dc.px(style.width);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  fn(ctx);
  ctx.restore();
}

function polyline(ctx: CanvasRenderingContext2D, pts: (Pt | null)[]) {
  ctx.beginPath();
  let pen = false;
  for (const p of pts) {
    if (!p) {
      pen = false;
      continue;
    }
    if (pen) ctx.lineTo(p.x, p.y);
    else ctx.moveTo(p.x, p.y);
    pen = true;
  }
  ctx.stroke();
}

function trail(dc: DrawContext, get: (f: number) => Pt | null) {
  const pts: (Pt | null)[] = [];
  for (let f = dc.from; f <= dc.to; f++) pts.push(get(f));
  return pts;
}

function dot(ctx: CanvasRenderingContext2D, p: Pt, r: number) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fill();
}

function label(dc: DrawContext, text: string, p: Pt, color = '#fff') {
  const { ctx } = dc;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.font = `600 ${dc.px(12)}px system-ui, sans-serif`;
  const w = ctx.measureText(text).width;
  const pad = dc.px(4);
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(p.x - pad, p.y - dc.px(14), w + pad * 2, dc.px(18));
  ctx.fillStyle = color;
  ctx.fillText(text, p.x, p.y);
  ctx.restore();
}

/** 在線段 a→b 兩端延伸 */
function extend(a: Pt, b: Pt, k: number): [Pt, Pt] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return [
    { x: a.x - dx * k, y: a.y - dy * k },
    { x: b.x + dx * k, y: b.y + dy * k },
  ];
}

/** 速度 → 顏色（藍 → 綠 → 黃 → 紅） */
function speedColor(v: number, vmax: number) {
  const r = Math.max(0, Math.min(1, v / (vmax || 1)));
  const hue = 220 - r * 220;
  return `hsl(${hue} 90% 55%)`;
}

const skeleton: LayerDef = {
  id: 'skeleton',
  defaultOn: true,
  views: [...all],
  defaultStyle: { color: '#e8f5e9', width: 2.5, opacity: 0.85 },
  draw: (dc) =>
    withStyle(dc, (ctx) => {
      const { fd, frame: f, W, H } = dc;
      for (const [a, b] of POSE_CONNECTIONS) {
        if (vis(fd, f, a) < 0.3 || vis(fd, f, b) < 0.3) continue;
        const p = lm(fd, f, a, W, H);
        const q = lm(fd, f, b, W, H);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
      }
      ctx.fillStyle = '#4caf50';
      for (let k = 11; k < 33; k++) if (vis(dc.fd, f, k) >= 0.3) dot(ctx, lm(fd, f, k, W, H), dc.px(3));
      dot(ctx, lm(fd, f, LM.nose, W, H), dc.px(4));
    }),
};

const clubPath: LayerDef = {
  id: 'clubPath',
  defaultOn: true,
  views: [...all],
  defaultStyle: { color: '#ffca28', width: 3, opacity: 0.95 },
  draw: (dc) =>
    withStyle(dc, (ctx) => {
      const { fd, W, H, result } = dc;
      const speed = result.series.clubSpeed;
      let vmax = 0;
      for (let f = 0; f < fd.n; f++) if (speed[f] > vmax) vmax = speed[f];
      for (let f = dc.from + 1; f <= dc.to; f++) {
        const a = clubPt(fd, f - 1, W, H);
        const b = clubPt(fd, f, W, H);
        if (!a || !b) continue;
        const est = fd.clubSource[f] === ClubSource.HandEstimate;
        ctx.setLineDash(est ? [dc.px(4), dc.px(4)] : []);
        ctx.strokeStyle = Number.isNaN(speed[f]) ? dc.style.color : speedColor(speed[f], vmax);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      const c = clubPt(fd, dc.frame, W, H);
      if (c) {
        ctx.fillStyle = dc.style.color;
        ctx.strokeStyle = '#000';
        ctx.lineWidth = dc.px(1.5);
        ctx.beginPath();
        ctx.arc(c.x, c.y, dc.px(6), 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }),
};

const clubShaft: LayerDef = {
  id: 'clubShaft',
  defaultOn: true,
  views: [...all],
  defaultStyle: { color: '#b0bec5', width: 2.5, opacity: 0.9 },
  draw: (dc) =>
    withStyle(dc, (ctx) => {
      const c = clubPt(dc.fd, dc.frame, dc.W, dc.H);
      if (!c) return;
      const h = handsCenter(dc.fd, dc.frame, dc.W, dc.H);
      if (dc.fd.clubSource[dc.frame] === ClubSource.HandEstimate) ctx.setLineDash([dc.px(6), dc.px(4)]);
      polyline(ctx, [h, c]);
    }),
};

const handPath: LayerDef = {
  id: 'handPath',
  defaultOn: true,
  views: [...all],
  defaultStyle: { color: '#29b6f6', width: 2.5, opacity: 0.9 },
  draw: (dc) =>
    withStyle(dc, (ctx) => {
      polyline(ctx, trail(dc, (f) => handsCenter(dc.fd, f, dc.W, dc.H)));
      dot(ctx, handsCenter(dc.fd, dc.frame, dc.W, dc.H), dc.px(4));
    }),
};

const headPath: LayerDef = {
  id: 'headPath',
  defaultOn: true,
  views: [...all],
  defaultStyle: { color: '#ef5350', width: 2, opacity: 0.9 },
  draw: (dc) =>
    withStyle(dc, (ctx) => {
      const { fd, W, H } = dc;
      const a = dc.result.phases.address;
      const p0 = lm(fd, a, LM.nose, W, H);
      const earL = lm(fd, a, LM.leftEar, W, H);
      const earR = lm(fd, a, LM.rightEar, W, H);
      const r = Math.max(Math.hypot(earL.x - earR.x, earL.y - earR.y), dc.px(20));
      ctx.setLineDash([dc.px(4), dc.px(4)]);
      ctx.strokeRect(p0.x - r, p0.y - r, r * 2, r * 2);
      ctx.setLineDash([]);
      polyline(ctx, trail(dc, (f) => lm(fd, f, LM.nose, W, H)));
      dot(ctx, lm(fd, dc.frame, LM.nose, W, H), dc.px(4));
    }),
};

const hipPath: LayerDef = {
  id: 'hipPath',
  defaultOn: true,
  views: ['dtl'],
  defaultStyle: { color: '#ab47bc', width: 2.5, opacity: 0.9 },
  draw: (dc) =>
    withStyle(dc, (ctx) => {
      const { fd, W, H } = dc;
      const a = dc.result.phases.address;
      // 準備姿勢的臀線（後方視角：臀部最外側的垂直參考線）
      const hip0 = hipCenter(fd, a, W, H);
      const knee = lm(fd, a, LM.rightKnee, W, H);
      ctx.setLineDash([dc.px(6), dc.px(4)]);
      polyline(ctx, [
        { x: hip0.x, y: hip0.y - (knee.y - hip0.y) * 0.8 },
        { x: hip0.x, y: knee.y },
      ]);
      ctx.setLineDash([]);
      polyline(ctx, trail(dc, (f) => hipCenter(fd, f, W, H)));
      const cur = hipCenter(fd, dc.frame, W, H);
      dot(ctx, cur, dc.px(5));
      const cm = dc.result.series.hipDepth[dc.frame];
      if (Number.isFinite(cm)) label(dc, `${cm > 0 ? '+' : ''}${cm.toFixed(1)} cm`, { x: cur.x + dc.px(8), y: cur.y }, dc.style.color);
    }),
};

const spineAngle: LayerDef = {
  id: 'spineAngle',
  defaultOn: true,
  views: ['dtl'],
  defaultStyle: { color: '#66bb6a', width: 3, opacity: 0.9 },
  draw: (dc) =>
    withStyle(dc, (ctx) => {
      const { fd, W, H } = dc;
      const a = dc.result.phases.address;
      const hip0 = hipCenter(fd, a, W, H);
      const sh0 = shoulderCenter(fd, a, W, H);
      ctx.globalAlpha = dc.style.opacity * 0.5;
      ctx.setLineDash([dc.px(6), dc.px(4)]);
      polyline(ctx, extend(hip0, sh0, 0.25));
      ctx.setLineDash([]);
      ctx.globalAlpha = dc.style.opacity;
      const hip = hipCenter(fd, dc.frame, W, H);
      const sh = shoulderCenter(fd, dc.frame, W, H);
      polyline(ctx, [hip, sh]);
      label(dc, `${angleFromVertical(hip, sh).toFixed(0)}°`, { x: sh.x + dc.px(8), y: sh.y }, dc.style.color);
    }),
};

const swingPlane: LayerDef = {
  id: 'swingPlane',
  defaultOn: true,
  views: ['dtl'],
  defaultStyle: { color: '#26c6da', width: 2, opacity: 0.8 },
  draw: (dc) =>
    withStyle(dc, (ctx) => {
      const { fd, W, H } = dc;
      const a = dc.result.phases.address;
      const ball = clubPt(fd, a, W, H);
      if (!ball) return;
      const hands = handsCenter(fd, a, W, H);
      const sh = shoulderCenter(fd, a, W, H);
      const far = (p: Pt) => {
        const k = (Math.max(W, H) * 2) / Math.max(1, Math.hypot(p.x - ball.x, p.y - ball.y));
        return { x: ball.x + (p.x - ball.x) * k, y: ball.y + (p.y - ball.y) * k };
      };
      polyline(ctx, [ball, far(hands)]);
      ctx.globalAlpha = dc.style.opacity * 0.7;
      ctx.setLineDash([dc.px(8), dc.px(5)]);
      polyline(ctx, [ball, far(sh)]);
      // 兩平面之間的區域
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.08;
      ctx.beginPath();
      ctx.moveTo(ball.x, ball.y);
      const fh = far(hands);
      const fs = far(sh);
      ctx.lineTo(fh.x, fh.y);
      ctx.lineTo(fs.x, fs.y);
      ctx.closePath();
      ctx.fill();
    }),
};

function segmentLayer(id: LayerId, kA: number, kB: number, color: string, defaultOn: boolean): LayerDef {
  return {
    id,
    defaultOn,
    views: [...all],
    defaultStyle: { color, width: 3, opacity: 0.9 },
    draw: (dc) =>
      withStyle(dc, (ctx) => {
        const a = lm(dc.fd, dc.frame, kA, dc.W, dc.H);
        const b = lm(dc.fd, dc.frame, kB, dc.W, dc.H);
        polyline(ctx, extend(a, b, 0.3));
      }),
  };
}

const PHASE_KEYS: (keyof Phases)[] = ['address', 'takeaway', 'top', 'impact', 'finish'];

const phaseMarkers: LayerDef = {
  id: 'phaseMarkers',
  defaultOn: true,
  views: [...all],
  defaultStyle: { color: '#ffffff', width: 2, opacity: 1 },
  draw: (dc) =>
    withStyle(dc, (ctx) => {
      for (const k of PHASE_KEYS) {
        const f = dc.result.phases[k];
        if (f > dc.to) continue;
        const p = clubPt(dc.fd, f, dc.W, dc.H) ?? handsCenter(dc.fd, f, dc.W, dc.H);
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = dc.px(1.5);
        ctx.beginPath();
        ctx.arc(p.x, p.y, dc.px(5), 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        label(dc, dc.t(`phase.${k}`), { x: p.x + dc.px(8), y: p.y - dc.px(6) });
      }
    }),
};

const rotationGauge: LayerDef = {
  id: 'rotationGauge',
  defaultOn: false,
  views: [...all],
  screenSpace: true,
  defaultStyle: { color: '#ffa726', width: 3, opacity: 0.95 },
  draw: (dc) => {
    const { ctx, frame, result } = dc;
    const sh = result.series.shoulderTurn[frame];
    const hp = result.series.hipTurn[frame];
    const R = 34;
    const cx = R + 10;
    const cy = R + 10;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.arc(cx, cy, R + 6, 0, Math.PI * 2);
    ctx.fill();
    const arc = (deg: number, r: number, color: string) => {
      if (!Number.isFinite(deg)) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 5;
      ctx.beginPath();
      const start = -Math.PI / 2;
      ctx.arc(cx, cy, r, start, start + (deg * Math.PI) / 180, deg < 0);
      ctx.stroke();
    };
    arc(sh, R - 2, dc.style.color);
    arc(hp, R - 10, '#ab47bc');
    ctx.fillStyle = '#fff';
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${Number.isFinite(sh) ? sh.toFixed(0) : '-'}°`, cx, cy - 2);
    ctx.fillStyle = '#e1bee7';
    ctx.fillText(`${Number.isFinite(hp) ? hp.toFixed(0) : '-'}°`, cx, cy + 12);
    ctx.restore();
  },
};

const grid: LayerDef = {
  id: 'grid',
  defaultOn: false,
  views: [...all],
  defaultStyle: { color: '#ffffff', width: 1, opacity: 0.25 },
  draw: (dc) =>
    withStyle(dc, (ctx) => {
      const step = Math.max(dc.W, dc.H) / 12;
      ctx.beginPath();
      for (let x = step; x < dc.W; x += step) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, dc.H);
      }
      for (let y = step; y < dc.H; y += step) {
        ctx.moveTo(0, y);
        ctx.lineTo(dc.W, y);
      }
      ctx.stroke();
    }),
};

export const LAYERS: LayerDef[] = [
  grid,
  swingPlane,
  skeleton,
  spineAngle,
  segmentLayer('shoulderLine', LM.leftShoulder, LM.rightShoulder, '#ffa726', false),
  segmentLayer('hipLine', LM.leftHip, LM.rightHip, '#ab47bc', false),
  hipPath,
  headPath,
  handPath,
  clubShaft,
  clubPath,
  phaseMarkers,
  rotationGauge,
];

export const LAYER_MAP = Object.fromEntries(LAYERS.map((l) => [l.id, l])) as Record<LayerId, LayerDef>;
