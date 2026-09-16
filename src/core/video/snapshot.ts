/** 從影片指定時間擷取一張 JPEG（瀏覽器會自動套用旋轉） */
export async function captureVideoFrame(blob: Blob, time: number, maxSide = 320, quality = 0.8): Promise<Blob | null> {
  const v = document.createElement('video');
  const url = URL.createObjectURL(blob);
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = url;
  try {
    await new Promise<void>((res, rej) => {
      v.onloadeddata = () => res();
      v.onerror = () => rej(new Error('video'));
    });
    await new Promise<void>((res) => {
      const timer = setTimeout(res, 3000);
      v.onseeked = () => {
        clearTimeout(timer);
        res();
      };
      v.currentTime = Math.min(time, Math.max(0, v.duration - 0.01));
    });
    const s = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(v.videoWidth * s);
    c.height = Math.round(v.videoHeight * s);
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
    return await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', quality));
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
