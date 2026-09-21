import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { getClubDetector, runInference, type InferenceProgress } from '../core/inference/runInference';
import type { PoseModel } from '../core/inference/pose';
import { LM, vis } from '../core/landmarks';
import { analyze } from '../core/pipeline';
import { smoothPose } from '../core/tracking/poseSmoothing';
import type { Thumb } from '../core/inference/runInference';
import { canvasToJpeg, captureVideoFrame } from '../core/video/snapshot';
import { withTimeout } from '../core/video/videoElement';
import { sliceFrames, shiftPhases } from '../core/sliceFrames';
import { trimVideo } from '../core/video/trimVideo';
import { db, saveSession } from '../storage/db';
import { getVideo, putVideo } from '../storage/videoStore';
import { useSettings } from '../store/settings';
import type { Quality } from './UploadPage';

const QUALITY: Record<Quality, { stride: number; maxSide: number; pose?: PoseModel }> = {
  fast: { stride: 2, maxSide: 720 },
  std: { stride: 1, maxSide: 960 },
  high: { stride: 1, maxSide: 1280, pose: 'heavy' },
};

type Stage = InferenceProgress['stage'] | 'post' | 'saving' | 'error';

/** 紀錄縮圖：優先用分析時擷取的畫面；沒有時才另開影片擷取（有逾時，失敗就不存縮圖） */
async function makeThumbnail(thumbs: Thumb[], time: number, blob: Blob): Promise<Blob | null> {
  let best: Thumb | null = null;
  for (const th of thumbs) if (!best || Math.abs(th.mediaTime - time) < Math.abs(best.mediaTime - time)) best = th;
  if (best) {
    const c = document.createElement('canvas');
    c.width = best.image.width;
    c.height = best.image.height;
    c.getContext('2d')!.putImageData(best.image, 0, 0);
    const jpg = await canvasToJpeg(c, c.width, c.height);
    if (jpg) return jpg;
  }
  return withTimeout(captureVideoFrame(blob, time), 8000, null);
}

/** 分析後保留的前後緩衝（秒） */
const KEEP_PAD_SEC = 1;

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
      const thumbnail = await makeThumbnail(out.thumbs, fd.mediaT[res.phases.impact], blob);

      // 只保留「準備前 1 秒」到「收桿後 1 秒」：影片重新封裝、逐格資料一併裁切
      let saved = fd;
      let phases = res.phases;
      let video = session.video;
      const keepFrom = fd.mediaT[res.phases.address] - KEEP_PAD_SEC;
      const keepTo = fd.mediaT[res.phases.finish] + KEEP_PAD_SEC;
      let from = 0;
      let to = fd.n - 1;
      while (from < res.phases.address && fd.mediaT[from] < keepFrom) from++;
      while (to > res.phases.finish && fd.mediaT[to] > keepTo) to--;
      if (from > 0 || to < fd.n - 1) {
        const trimmed = await trimVideo(blob, fd.mediaT[from], fd.mediaT[to]).catch(() => null);
        if (trimmed) {
          await putVideo(session.video.storageKey, trimmed.blob);
          saved = sliceFrames(fd, from, to, trimmed.offset);
          phases = shiftPhases(res.phases, from, saved.n);
          video = {
            ...session.video,
            durationSec: trimmed.durationSec,
            trimStart: saved.mediaT[0],
            trimEnd: saved.mediaT[saved.n - 1],
          };
        }
      }

      const saving = saveSession(
        {
          ...session,
          video,
          phases,
          phasesManual: false,
          calibration: res.calibration,
          metrics: res.metrics,
          thumbnail,
          modelVersions: out.modelVersions,
        },
        saved,
      );
      // 儲存不應超過數秒；萬一瀏覽器的儲存空間沒有回應，顯示錯誤而不是一直停在「儲存中」
      const ok = await withTimeout(saving.then(() => true), 60000, false);
      if (!ok) throw new Error(t('analyze.saveTimeout'));
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
          {noClub && <div className="notice muted">{t('analyze.noClubModel')}</div>}
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
