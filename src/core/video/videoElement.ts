/**
 * 以隱藏的 <video> 讀取影片畫面的共用工具。
 * iOS Safari 對沒有放在畫面上、也沒有播放過的影片元件，常常不會載入畫面資料，
 * 因此所有等待都設有逾時，必要時以靜音播放一下強制解碼。
 */

export class VideoTimeoutError extends Error {
  constructor(what: string) {
    super(`video-timeout:${what}`);
  }
}

function once(v: HTMLVideoElement, events: string[], timeoutMs: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (err?: Error) => {
      clearTimeout(timer);
      for (const e of events) v.removeEventListener(e, ok);
      v.removeEventListener('error', fail);
      if (err) reject(err);
      else resolve();
    };
    const ok = () => done();
    const fail = () => done(new Error('unsupported-video'));
    const timer = setTimeout(() => done(new VideoTimeoutError(what)), timeoutMs);
    for (const e of events) v.addEventListener(e, ok);
    v.addEventListener('error', fail);
  });
}

export interface LoadedVideo {
  video: HTMLVideoElement;
  dispose: () => void;
}

/** 建立並載入隱藏影片，等到可以取得畫面為止 */
export async function loadVideo(blob: Blob, timeoutMs = 10000): Promise<LoadedVideo> {
  const v = document.createElement('video');
  const url = URL.createObjectURL(blob);
  v.muted = true;
  v.defaultMuted = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.setAttribute('webkit-playsinline', '');
  v.preload = 'auto';
  // iOS 對完全不在畫面上的元件較不積極載入，放在畫面外的極小元件上
  v.style.cssText = 'position:fixed;left:-10px;top:-10px;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.appendChild(v);
  const dispose = () => {
    v.pause();
    v.removeAttribute('src');
    v.load();
    v.remove();
    URL.revokeObjectURL(url);
  };
  try {
    const meta = once(v, ['loadedmetadata'], timeoutMs, 'metadata');
    v.src = url;
    v.load();
    await meta;
    if (v.readyState < 2) {
      const data = once(v, ['loadeddata', 'canplay'], 3000, 'data');
      // 靜音內嵌播放是 iOS 允許的；播放一下即可取得畫面
      await v.play().catch(() => undefined);
      v.pause();
      await data.catch(() => undefined);
    }
    return { video: v, dispose };
  } catch (e) {
    dispose();
    throw e;
  }
}

/** 跳到指定時間並等畫面更新（逾時也會繼續，避免卡住） */
export async function seekVideo(v: HTMLVideoElement, time: number, timeoutMs = 3000): Promise<void> {
  const target = Math.min(Math.max(0, time), Math.max(0, (v.duration || time) - 0.001));
  if (Math.abs(v.currentTime - target) < 1e-4 && v.readyState >= 2) return;
  const seeked = once(v, ['seeked'], timeoutMs, 'seek');
  v.currentTime = target;
  await seeked.catch(() => undefined);
  if ('requestVideoFrameCallback' in v) {
    await Promise.race([
      new Promise<void>((r) => (v as HTMLVideoElement).requestVideoFrameCallback(() => r())),
      new Promise<void>((r) => setTimeout(r, 300)),
    ]);
  }
}

/** 為任一 Promise 加上逾時；逾時回傳 fallback */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}
