import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { IconCamera } from '../components/Icons';
import RangeDual from '../components/RangeDual';
import { DEFAULT_CLUB_LENGTH_CM } from '../core/calibration/calibration';
import { clubLabel, CLUBS } from '../core/clubs';
import { probeVideo, type ProbeResult } from '../core/video/probe';
import { saveSession } from '../storage/db';
import { putVideo } from '../storage/videoStore';
import { useSettings } from '../store/settings';
import type { CaptureInfo, ClubType, SessionRecord } from '../types';

export type Quality = 'fast' | 'std' | 'high';

export default function UploadPage() {
  const { t, i18n } = useTranslation();
  const nav = useNavigate();
  const defaults = useSettings((s) => s.captureDefaults);
  const setDefaults = useSettings((s) => s.setCaptureDefaults);

  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [capture, setCapture] = useState<CaptureInfo>({ ...defaults, viewAngle: 'dtl' });
  const [fps, setFps] = useState(60);
  const [slowMo, setSlowMo] = useState(1);
  const [trim, setTrim] = useState<[number, number]>([0, 0]);
  const [quality, setQuality] = useState<Quality>('std');
  const [busy, setBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    setProbe(null);
    try {
      const p = await probeVideo(f);
      setFile(f);
      setUrl(URL.createObjectURL(f));
      setProbe(p);
      setFps(Math.round(p.fps) || 60);
      setTrim([0, Math.min(p.durationSec, 15)]);
    } catch {
      setError(t('upload.unsupported'));
    }
  };

  const onTrim = (v: [number, number], moved: 0 | 1) => {
    setTrim(v);
    if (videoRef.current) videoRef.current.currentTime = v[moved];
  };

  const update = <K extends keyof CaptureInfo>(k: K, v: CaptureInfo[K]) => setCapture((c) => ({ ...c, [k]: v }));

  const start = async () => {
    if (!file || !probe) return;
    setBusy(true);
    try {
      const id = crypto.randomUUID();
      await putVideo(id, file);
      const now = Date.now();
      const date = new Intl.DateTimeFormat(i18n.language, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(now);
      const session: SessionRecord = {
        id,
        createdAt: now,
        updatedAt: now,
        title: `${clubLabel(capture.clubType, i18n.language)} ${date}`,
        notes: '',
        favorite: false,
        video: {
          storageKey: id,
          fileName: file.name,
          mimeType: file.type || 'video/mp4',
          durationSec: probe.durationSec,
          fps,
          width: probe.width,
          height: probe.height,
          rotation: probe.rotation,
          slowMoFactor: slowMo,
          trimStart: trim[0],
          trimEnd: trim[1],
        },
        capture,
        phases: null,
        calibration: null,
        metrics: null,
        thumbnail: null,
        modelVersions: { pose: '', club: '' },
      };
      await saveSession(session);
      setDefaults(capture);
      nav(`/analyze/${id}?q=${quality}`, { replace: true });
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const span = trim[1] - trim[0];

  return (
    <div className="stack">
      <h2 style={{ margin: 0 }}>{t('upload.title')}</h2>

      {!file && (
        <div className="card stack">
          <div className="row pick-row">
            <label className="btn primary">
              {t('upload.pick')}
              <input type="file" accept="video/*" hidden onChange={(e) => onFile(e.target.files?.[0])} />
            </label>
            <label className="btn">
              <IconCamera size={18} /> {t('upload.record')}
              <input type="file" accept="video/*" capture="environment" hidden onChange={(e) => onFile(e.target.files?.[0])} />
            </label>
          </div>
          {error && <div className="notice error">{error}</div>}
          <div className="stack" style={{ gap: 4 }}>
            <strong>{t('upload.guideTitle')}</strong>
            <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
              <li>{t('upload.guide1')}</li>
              <li>{t('upload.guide2')}</li>
              <li>{t('upload.guide3')}</li>
              <li>{t('upload.guide4')}</li>
            </ul>
          </div>
        </div>
      )}

      {file && probe && url && (
        <>
          {/* 影片、時間軸、開始分析同一區塊並黏在頂端，捲動看設定時仍看得到 */}
          <div className="upload-stage">
            <div className="card stack" style={{ gap: 10 }}>
              <video ref={videoRef} src={url} className="preview-canvas" muted playsInline controls preload="metadata" />
              <div className="stack" style={{ gap: 4 }}>
                <div className="row" style={{ gap: 6 }}>
                  <span className="muted">{t('upload.trim')}</span>
                  <span className="trim-time">
                    {trim[0].toFixed(2)}s – {trim[1].toFixed(2)}s
                  </span>
                  <span className={`chip ${span > 15 ? 'warn' : ''}`}>{span.toFixed(2)}s</span>
                </div>
                <RangeDual min={0} max={probe.durationSec} step={0.01} value={trim} onChange={onTrim} />
              </div>
              {error && <div className="notice error">{error}</div>}
              {span > 15 && <div className="notice warn">{t('upload.tooLong')}</div>}
              <button className="btn primary block" disabled={busy || span <= 0.3} onClick={start}>
                {t('upload.analyze')}
              </button>
            </div>
          </div>

          <div className="card stack">
            <div className="row" style={{ gap: 6 }}>
              <span className="muted" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {file.name} · {probe.width}×{probe.height} · {probe.fps} fps
              </span>
              <label className="btn small">
                {t('upload.pick')}
                <input type="file" accept="video/*" hidden onChange={(e) => onFile(e.target.files?.[0])} />
              </label>
              <label className="btn small">
                <IconCamera size={16} /> {t('upload.record')}
                <input type="file" accept="video/*" capture="environment" hidden onChange={(e) => onFile(e.target.files?.[0])} />
              </label>
            </div>
          </div>

          <div className="card stack">
            <div className="field">
              <span>{t('upload.view')}</span>
              <div className="segmented">
                <button aria-pressed={capture.viewAngle === 'dtl'} onClick={() => update('viewAngle', 'dtl')}>
                  {t('upload.viewDtl')}
                </button>
                <button aria-pressed={false} disabled title={t('upload.faceOnUnsupported')}>
                  {t('upload.viewFaceOn')}
                </button>
              </div>
            </div>
            <div className="field">
              <span>{t('upload.handedness')}</span>
              <div className="segmented">
                {(['right', 'left'] as const).map((h) => (
                  <button key={h} aria-pressed={capture.handedness === h} onClick={() => update('handedness', h)}>
                    {t(`upload.${h}`)}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid-2">
              <label className="field">
                <span>{t('upload.height')}</span>
                <input type="number" inputMode="numeric" min={100} max={230} value={capture.heightCm} onChange={(e) => update('heightCm', Number(e.target.value))} />
              </label>
              <label className="field">
                <span>{t('upload.club')}</span>
                <select
                  value={capture.clubType}
                  onChange={(e) => {
                    const c = e.target.value as ClubType;
                    setCapture((x) => ({ ...x, clubType: c, clubLengthCm: DEFAULT_CLUB_LENGTH_CM[c] }));
                  }}
                >
                  {CLUBS.map((c) => (
                    <option key={c} value={c}>
                      {clubLabel(c, i18n.language)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t('upload.clubLength')}</span>
                <input type="number" inputMode="numeric" min={70} max={125} value={capture.clubLengthCm} onChange={(e) => update('clubLengthCm', Number(e.target.value))} />
              </label>
              <label className="field">
                <span>{t('upload.fps')}</span>
                <input type="number" inputMode="numeric" min={15} max={1000} value={fps} onChange={(e) => setFps(Number(e.target.value))} />
              </label>
              <label className="field">
                <span>{t('upload.slowMo')}</span>
                <input type="number" inputMode="decimal" min={1} max={32} step={0.5} value={slowMo} onChange={(e) => setSlowMo(Math.max(1, Number(e.target.value)))} />
              </label>
              <label className="field">
                <span>{t('upload.quality')}</span>
                <select value={quality} onChange={(e) => setQuality(e.target.value as Quality)}>
                  <option value="fast">{t('upload.qualityFast')}</option>
                  <option value="std">{t('upload.qualityStd')}</option>
                  <option value="high">{t('upload.qualityHigh')}</option>
                </select>
              </label>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              {t('upload.slowMoHint')}
            </p>
            <p className="muted" style={{ margin: 0 }}>
              {t('upload.trimHint')}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
