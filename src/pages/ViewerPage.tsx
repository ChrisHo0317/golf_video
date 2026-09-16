import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { IconDownload, IconLayers, IconNext, IconPause, IconPlay, IconPrev, IconTarget } from '../components/Icons';
import Charts from '../components/viewer/Charts';
import LayerPanel from '../components/viewer/LayerPanel';
import MetricsPanel from '../components/viewer/MetricsPanel';
import Timeline from '../components/viewer/Timeline';
import { sessionToCsv, sessionToJson } from '../core/export/dataExport';
import { shareOrDownload, timestampName } from '../core/export/share';
import { analyze, type AnalysisResult } from '../core/pipeline';
import { exportAnnotatedVideo, nearestFrame } from '../overlay/exportVideo';
import { renderOverlay, screenToVideo } from '../overlay/renderer';
import { db, loadFrames, saveSession } from '../storage/db';
import { getVideo } from '../storage/videoStore';
import { useSettings } from '../store/settings';
import { ClubSource, type FrameData, type Phases, type SessionRecord } from '../types';

type Tab = 'charts' | 'metrics' | 'phases' | 'notes';
const SPEEDS = [0.1, 0.25, 0.5, 1];
const NO_ZOOM = { k: 1, x: 0, y: 0 };

interface Loaded {
  session: SessionRecord;
  fd: FrameData;
  blob: Blob;
  url: string;
}

export default function ViewerPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { layers, trailMode } = useSettings();

  const [data, setData] = useState<Loaded | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(0.25);
  const [tab, setTab] = useState<Tab>('charts');
  const [showLayers, setShowLayers] = useState(false);
  const [editClub, setEditClub] = useState(false);
  const [exporting, setExporting] = useState<number | null>(null);
  const [zoom, setZoom] = useState(NO_ZOOM);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<number | undefined>(undefined);

  // ---- 載入 ----
  useEffect(() => {
    let url = '';
    let cancelled = false;
    (async () => {
      const session = await db.sessions.get(id);
      if (!session) throw new Error(t('viewer.notFound'));
      const [fd, blob] = await Promise.all([loadFrames(id), getVideo(session.video.storageKey)]);
      if (!fd) throw new Error(t('viewer.notFound'));
      if (!blob) throw new Error(t('viewer.videoMissing'));
      if (cancelled) return;
      url = URL.createObjectURL(blob);
      const { width: W, height: H } = session.video;
      const res = analyze(fd, session.capture, W, H, session.phasesManual ? session.phases : null);
      setData({ session, fd, blob, url });
      setResult(res);
      if (res) setFrame(res.phases.address);
    })().catch((e) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, t]);

  const W = data?.session.video.width ?? 1;
  const H = data?.session.video.height ?? 1;
  const fd = data?.fd;

  // ---- 影片與影格同步 ----
  const seekFrame = useCallback(
    (f: number) => {
      const v = videoRef.current;
      if (!fd || !v) return;
      const ff = Math.max(0, Math.min(fd.n - 1, f));
      v.pause();
      setFrame(ff);
      v.currentTime = fd.mediaT[ff] + 0.0005;
    },
    [fd],
  );

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !fd || !result) return;
    const start = fd.mediaT[0];
    const end = fd.mediaT[fd.n - 1];
    let handle = 0;
    let raf = 0;
    const onTime = (time: number) => {
      if (!v.paused && time >= end) {
        v.currentTime = start;
        return;
      }
      setFrame(nearestFrame(fd.mediaT, time));
    };
    const useRvfc = 'requestVideoFrameCallback' in v;
    const tick = (_n: number, meta: VideoFrameCallbackMetadata) => {
      // 暫停時影格由 seekFrame 決定，避免影片實際格率與分析格率不同時被拉回前一格
      if (!v.paused) onTime(meta.mediaTime);
      handle = v.requestVideoFrameCallback(tick);
    };
    const loop = () => {
      if (!v.paused) onTime(v.currentTime);
      raf = requestAnimationFrame(loop);
    };
    if (useRvfc) handle = v.requestVideoFrameCallback(tick);
    else raf = requestAnimationFrame(loop);
    const onPlay = () => {
      if (v.currentTime < start || v.currentTime >= end) v.currentTime = start;
      setPlaying(true);
    };
    const onPause = () => setPlaying(false);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onPause);
    v.currentTime = fd.mediaT[result.phases.address] + 0.0005;
    return () => {
      if (useRvfc) v.cancelVideoFrameCallback(handle);
      cancelAnimationFrame(raf);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onPause);
    };
    // result 只在初次載入時需要
  }, [fd, data?.url]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, [rate, data?.url]);

  // ---- 繪製疊加 ----
  const draw = useCallback(() => {
    const c = canvasRef.current;
    if (!c || !fd || !result || !data) return;
    renderOverlay({ canvas: c, fd, frame, W, H, result, capture: data.session.capture, layers, trailMode, zoom: NO_ZOOM, t });
  }, [fd, frame, W, H, result, data, layers, trailMode, t]);

  useEffect(draw, [draw]);
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(c);
    return () => ro.disconnect();
  }, [draw]);

  // ---- 重算與儲存 ----
  const recompute = useCallback(
    (phasesOverride: Phases | null, persistFrames: boolean) => {
      if (!data) return;
      const res = analyze(data.fd, data.session.capture, W, H, phasesOverride);
      if (!res) return;
      setResult(res);
      const session: SessionRecord = {
        ...data.session,
        phases: res.phases,
        phasesManual: phasesOverride != null,
        calibration: res.calibration,
        metrics: res.metrics,
      };
      setData({ ...data, session });
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void saveSession(session, persistFrames ? data.fd : undefined), 400);
    },
    [data, W, H],
  );

  const setPhase = (k: keyof Phases) => {
    if (!result) return;
    recompute({ ...result.phases, [k]: frame }, false);
  };

  const onStageClick = (e: React.MouseEvent) => {
    if (!editClub || !data || !result || !canvasRef.current) return;
    const c = canvasRef.current;
    const r = c.getBoundingClientRect();
    const lx = ((e.clientX - r.left) / r.width) * c.clientWidth;
    const ly = ((e.clientY - r.top) / r.height) * c.clientHeight;
    const p = screenToVideo(lx, ly, c, W, H, NO_ZOOM);
    if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return;
    const f = frame;
    const { fd: d, session } = data;
    d.clubRaw[f * 3] = p.x;
    d.clubRaw[f * 3 + 1] = p.y;
    d.clubRaw[f * 3 + 2] = 1;
    d.clubRawSource[f] = ClubSource.Manual;
    const boxSize = Math.max(0.015, (0.08 * result.clubLengthPx) / Math.max(W, H));
    void db.labels.put({
      id: `${session.id}:${f}`,
      sessionId: session.id,
      frame: f,
      mediaTime: d.mediaT[f],
      x: p.x,
      y: p.y,
      boxSize,
      createdAt: Date.now(),
    });
    recompute(session.phasesManual ? session.phases : null, true);
  };

  const clearManual = () => {
    if (!data) return;
    const d = data.fd;
    if (d.clubRawSource[frame] !== ClubSource.Manual) return;
    d.clubRaw[frame * 3] = NaN;
    d.clubRaw[frame * 3 + 1] = NaN;
    d.clubRaw[frame * 3 + 2] = 0;
    d.clubRawSource[frame] = ClubSource.None;
    void db.labels.delete(`${data.session.id}:${frame}`);
    recompute(data.session.phasesManual ? data.session.phases : null, true);
  };

  // ---- 縮放（雙指 / 滾輪）----
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; k: number; cx: number; cy: number; x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const r = stageRef.current!.getBoundingClientRect();
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), k: zoom.k, cx: (a.x + b.x) / 2 - r.left, cy: (a.y + b.y) / 2 - r.top, x: zoom.x, y: zoom.y };
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const prev = pointers.current.get(e.pointerId)!;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const p = pinch.current;
      const k = Math.min(6, Math.max(1, (p.k * Math.hypot(a.x - b.x, a.y - b.y)) / p.d));
      const ox = p.cx - ((p.cx - p.x) * k) / p.k;
      const oy = p.cy - ((p.cy - p.y) * k) / p.k;
      setZoom(clampZoom({ k, x: ox, y: oy }));
    } else if (zoom.k > 1 && !editClub) {
      setZoom((z) => clampZoom({ ...z, x: z.x + e.clientX - prev.x, y: z.y + e.clientY - prev.y }));
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };
  const clampZoom = (z: { k: number; x: number; y: number }) => {
    const el = stageRef.current;
    if (!el || z.k <= 1) return NO_ZOOM;
    const w = el.clientWidth;
    const h = el.clientHeight;
    return { k: z.k, x: Math.min(0, Math.max(w - w * z.k, z.x)), y: Math.min(0, Math.max(h - h * z.k, z.y)) };
  };
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      setZoom((z) => {
        const k = Math.min(6, Math.max(1, z.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        return clampZoom({ k, x: cx - ((cx - z.x) * k) / z.k, y: cy - ((cy - z.y) * k) / z.k });
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  // ---- 鍵盤 ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      if (e.key === 'ArrowLeft') seekFrame(frame - 1);
      else if (e.key === 'ArrowRight') seekFrame(frame + 1);
      else if (e.key === ' ') {
        e.preventDefault();
        togglePlay();
      } else return;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  };

  // ---- 匯出 ----
  const snapshot = async () => {
    const v = videoRef.current;
    if (!v || !fd || !result || !data) return;
    const s = Math.min(1, 1920 / Math.max(W, H));
    const c = document.createElement('canvas');
    c.width = Math.round(W * s);
    c.height = Math.round(H * s);
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
    renderOverlay({ canvas: c, fd, frame, W, H, result, capture: data.session.capture, layers, trailMode, zoom: NO_ZOOM, t, size: { w: c.width, h: c.height, dpr: 1 } });
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
    if (blob) await shareOrDownload(blob, timestampName('swing', 'png'));
  };

  const exportVideo = async () => {
    if (!fd || !result || !data) return;
    videoRef.current?.pause();
    setExporting(0);
    try {
      const out = await exportAnnotatedVideo({
        blob: data.blob,
        fd,
        W,
        H,
        result,
        capture: data.session.capture,
        layers,
        trailMode,
        t,
        onProgress: (p) => setExporting(Math.round(p * 100)),
      });
      await shareOrDownload(out.blob, timestampName('swing', out.ext));
    } catch (e) {
      alert(String(e));
    } finally {
      setExporting(null);
    }
  };

  const phasesKeys = useMemo(() => ['address', 'takeaway', 'top', 'impact', 'finish'] as (keyof Phases)[], []);

  if (error) return <div className="notice error">{error}</div>;
  if (!data || !fd) return null;
  if (!result) return <div className="notice error">{t('analyze.noPose')}</div>;

  const isManual = fd.clubRawSource[frame] === ClubSource.Manual;

  return (
    <div className="viewer">
      <div className="viewer-left stack">
        <div
          ref={stageRef}
          className="stage"
          style={{ aspectRatio: `${W} / ${H}`, maxHeight: '72dvh', cursor: editClub ? 'crosshair' : undefined }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onClick={onStageClick}
          onDoubleClick={() => setZoom(NO_ZOOM)}
        >
          <div className="zoom-layer" style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.k})` }}>
            <video ref={videoRef} src={data.url} muted playsInline preload="auto" />
            <canvas ref={canvasRef} />
          </div>
          <div className="stage-tools" onClick={(e) => e.stopPropagation()}>
            <button className={`btn small ${editClub ? 'active' : ''}`} onClick={() => setEditClub(!editClub)} aria-pressed={editClub}>
              <IconTarget size={16} /> {editClub ? t('viewer.done') : t('viewer.editClub')}
            </button>
            <button className="btn small" onClick={() => setShowLayers(true)}>
              <IconLayers size={16} /> {t('viewer.layers')}
            </button>
          </div>
          {editClub && (
            <div className="edit-hint" onClick={(e) => e.stopPropagation()}>
              {t('viewer.editClubHint')}
              {isManual && (
                <button className="btn small" style={{ marginLeft: 8 }} onClick={clearManual}>
                  {t('viewer.clearManual')}
                </button>
              )}
            </div>
          )}
        </div>

        <div className="controls">
          <button className="btn icon-btn" onClick={() => seekFrame(frame - 1)} aria-label="prev">
            <IconPrev />
          </button>
          <button className="btn primary icon-btn" onClick={togglePlay} aria-label="play">
            {playing ? <IconPause /> : <IconPlay />}
          </button>
          <button className="btn icon-btn" onClick={() => seekFrame(frame + 1)} aria-label="next">
            <IconNext />
          </button>
          <select className="btn small" value={rate} onChange={(e) => setRate(Number(e.target.value))} aria-label={t('viewer.speed')}>
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}x
              </option>
            ))}
          </select>
          <span className="time">
            {fd.t[frame].toFixed(3)}s · #{frame + 1}/{fd.n}
          </span>
        </div>
        <Timeline n={fd.n} frame={frame} phases={result.phases} onSeek={seekFrame} />
        <div className="phase-jumps">
          {phasesKeys.map((k) => (
            <button key={k} className={`btn small ${frame === result.phases[k] ? 'active' : ''}`} onClick={() => seekFrame(result.phases[k])}>
              {t(`phase.${k}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="stack">
        <div className="row">
          <strong style={{ flex: 1, minWidth: 0 }}>{data.session.title}</strong>
          <button className="btn small" onClick={snapshot}>
            <IconDownload size={16} /> {t('viewer.snapshot')}
          </button>
          <button className="btn small" disabled={exporting != null} onClick={exportVideo}>
            {exporting != null ? t('viewer.exporting', { pct: exporting }) : t('viewer.exportVideo')}
          </button>
        </div>
        <div className="tabs" role="tablist">
          {(['charts', 'metrics', 'phases', 'notes'] as Tab[]).map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
              {t(`viewer.tabs.${k}`)}
            </button>
          ))}
        </div>

        {tab === 'charts' && <Charts t={fd.t} series={result.series} phases={result.phases} frame={frame} onSeek={seekFrame} />}
        {tab === 'metrics' && <MetricsPanel result={result} fd={fd} capture={data.session.capture} W={W} H={H} />}
        {tab === 'phases' && (
          <div className="stack">
            <div className="table-wrap">
              <table className="data">
                <tbody>
                  {phasesKeys.map((k) => (
                    <tr key={k}>
                      <td>{t(`phase.${k}`)}</td>
                      <td>
                        <button className="btn small ghost" onClick={() => seekFrame(result.phases[k])}>
                          #{result.phases[k] + 1} · {fd.t[result.phases[k]].toFixed(3)}s
                        </button>
                      </td>
                      <td>
                        <button className="btn small" onClick={() => setPhase(k)} disabled={frame === result.phases[k]}>
                          {t('viewer.setPhase')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.session.phasesManual && (
              <div>
                <button className="btn small" onClick={() => recompute(null, false)}>
                  {t('viewer.resetPhases')}
                </button>
              </div>
            )}
          </div>
        )}
        {tab === 'notes' && (
          <div className="stack">
            <label className="field">
              <span>{t('viewer.title')}</span>
              <input
                value={data.session.title}
                onChange={(e) => {
                  const session = { ...data.session, title: e.target.value };
                  setData({ ...data, session });
                  void db.sessions.update(session.id, { title: session.title });
                }}
              />
            </label>
            <label className="field">
              <span>{t('viewer.tabs.notes')}</span>
              <textarea
                rows={6}
                placeholder={t('viewer.notesPlaceholder')}
                value={data.session.notes}
                onChange={(e) => {
                  const session = { ...data.session, notes: e.target.value };
                  setData({ ...data, session });
                  void db.sessions.update(session.id, { notes: session.notes });
                }}
              />
            </label>
            <div className="row">
              <button className="btn small" onClick={() => shareOrDownload(sessionToJson(data.session, fd, result.series), timestampName('swing', 'json'))}>
                {t('viewer.exportJson')}
              </button>
              <button className="btn small" onClick={() => shareOrDownload(sessionToCsv(fd, result.series), timestampName('swing', 'csv'))}>
                {t('viewer.exportCsv')}
              </button>
            </div>
            <p className="muted">
              pose: {data.session.modelVersions.pose} · club: {data.session.modelVersions.club} · {data.session.video.fps} fps × {data.session.video.slowMoFactor}
            </p>
          </div>
        )}
      </div>

      {showLayers && <LayerPanel view={data.session.capture.viewAngle} onClose={() => setShowLayers(false)} />}
    </div>
  );
}
