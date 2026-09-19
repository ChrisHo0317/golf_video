import { loadVideo, seekVideo, withTimeout } from './videoElement';

/** 把畫布（或其中的影像）縮小成 JPEG */
export function canvasToJpeg(src: CanvasImageSource, sw: number, sh: number, maxSide = 320, quality = 0.8): Promise<Blob | null> {
  const s = Math.min(1, maxSide / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * s));
  c.height = Math.max(1, Math.round(sh * s));
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  return withTimeout(new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', quality)), 3000, null);
}

/** 從影片指定時間擷取一張 JPEG（瀏覽器會自動套用旋轉）；失敗或逾時回傳 null */
export async function captureVideoFrame(blob: Blob, time: number, maxSide = 320, quality = 0.8): Promise<Blob | null> {
  const run = async () => {
    const { video, dispose } = await loadVideo(blob, 6000);
    try {
      await seekVideo(video, time);
      return await canvasToJpeg(video, video.videoWidth, video.videoHeight, maxSide, quality);
    } finally {
      dispose();
    }
  };
  return withTimeout(run().catch(() => null), 10000, null);
}
