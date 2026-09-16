import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { getClubDetector, runInference, type InferenceProgress } from '../core/inference/runInference';
import type { PoseModel } from '../core/inference/pose';
import { LM, vis } from '../core/landmarks';
import { analyze } from '../core/pipeline';
import { smoothPose } from '../core/tracking/poseSmoothing';
import { captureVideoFrame } from '../core/video/snapshot';
import { db, saveSession } from '../storage/db';
import { getVideo } from '../storage/videoStore';
import { useSettings } from '../store/settings';
import type { Quality } from './UploadPage';

const QUALITY: Record<Quality, { stride: number; maxSide: number; pose?: PoseModel }> = {
  fast: { stride: 2, maxSide: 720 },
  std: { stride: 1, maxSide: 960 },
  high: { stride: 1, maxSide: 1280, pose: 'heavy' },
};

type Stage = InferenceProgress['stage'] | 'post' | 'saving' | 'error';

export default function AnalyzePage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const { t } = useTranslation();
  const nav = useNavigate();
  const poseModel = useSettings((s) => s.poseModel);
  const [stage, setStage] = useState<Stage>('loading');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [noClub, setNoClub] = useState(false);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const started = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const abort = new AbortController();
    abortRef.current = abort;
    const q = QUALITY[(params.get('q') as Quality) ?? 'std'] ?? QUALITY.std;

    (async () => {
      const session = await db.sessions.get(id);
      if (!session) throw new Error(t('viewer.notFound'));
      const blob = await getVideo(session.video.storageKey);
      if (!blob) throw new Error(t('viewer.videoMissing'));
      void getClubDetector().then((d) => setNoClub(!d));

      const out = await runInference(blob, session.video, {
        poseModel: q.pose ?? poseModel,
        stride: q.stride,
        maxSide: q.maxSide,
        signal: abort.signal,
        onProgress: (p) => {
          setStage(p.stage);
          setProgress({ done: p.done, total: p.total });
          const c = previewRef.current;
          if (p.preview && c) {
            if (c.width !== p.preview.width || c.height !== p.preview.height) {
              c.width = p.preview.width;
              c.height = p.preview.height;
            }
            c.getContext('2d')!.drawImage(p.preview, 0, 0);
          }
        },
      });
      if (abort.signal.aborted) return;
      const fd = out.frames;
      let seen = 0;
      for (let f = 0; f < fd.n; f++) if (vis(fd, f, LM.leftShoulder) > 0.3) seen++;
      if (fd.n < 10 || seen < fd.n * 0.3) throw new Error(t('analyze.noPose'));

      setStage('post');
      await new Promise((r) => setTimeout(r, 0));
      smoothPose(fd);
      const { width: W, height: H } = session.video;
      const res = analyze(fd, session.capture, W, H);
      if (!res) throw new Error(t('analyze.noPose'));

      setStage('saving');
      const thumbnail = await captureVideoFrame(blob, fd.mediaT[res.phases.impact]);
      await saveSession(
        {
          ...session,
          phases: res.phases,
          phasesManual: false,
          calibration: res.calibration,
          metrics: res.metrics,
          thumbnail,
          modelVersions: out.modelVersions,
        },
        fd,
      );
      nav(`/session/${id}`, { replace: true });
    })().catch((e: unknown) => {
      if ((e as DOMException)?.name === 'AbortError') return;
      console.error(e);
      setStage('error');
      setError(e instanceof Error ? e.message : String(e));
    });
  }, [id, params, poseModel, nav, t]);

  // 離開頁面時中止分析（延後判斷，避免 StrictMode 的模擬卸載誤觸）
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      setTimeout(() => {
        if (!mounted.current) abortRef.current?.abort();
      }, 0);
    };
  }, []);

  const cancel = () => {
    abortRef.current?.abort();
    nav('/', { replace: true });
  };

  const pct = progress.total ? Math.min(100, (progress.done / progress.total) * 100) : 0;
  const label =
    stage === 'loading'
      ? t('analyze.loading')
      : stage === 'processing'
        ? t('analyze.processing', { done: progress.done, total: progress.total })
        : stage === 'post'
          ? t('analyze.post')
          : stage === 'saving'
            ? t('analyze.saving')
            : '';

  return (
    <div className="stack">
      <canvas ref={previewRef} className="preview-canvas" />
      {stage !== 'error' ? (
        <div className="card stack">
          <div>{label}</div>
          <div className="progress">
            <div style={{ width: `${stage === 'loading' ? 2 : stage === 'processing' ? pct : 100}%` }} />
          </div>
          {noClub && <div className="notice warn">{t('analyze.noClubModel')}</div>}
          <div>
            <button className="btn" onClick={cancel}>
              {t('analyze.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="card stack">
          <div className="notice error">{t('analyze.failed', { msg: error })}</div>
          <div className="row">
            <button className="btn" onClick={() => nav('/', { replace: true })}>
              {t('nav.home')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
