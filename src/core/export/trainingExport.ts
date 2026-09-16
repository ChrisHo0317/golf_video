import { zipSync, strToU8, type Zippable } from 'fflate';
import { db } from '../../storage/db';
import { getVideo } from '../../storage/videoStore';

/**
 * 匯出手動標註的桿頭為 YOLO 格式資料集：
 *   images/<id>.jpg、labels/<id>.txt、data.yaml
 */
export async function exportTrainingData(onProgress?: (done: number, total: number) => void): Promise<Blob | null> {
  const labels = await db.labels.toArray();
  if (!labels.length) return null;
  const bySession = new Map<string, typeof labels>();
  for (const l of labels) bySession.set(l.sessionId, [...(bySession.get(l.sessionId) ?? []), l]);

  const files: Zippable = {};
  let done = 0;
  for (const [sid, rows] of bySession) {
    const s = await db.sessions.get(sid);
    if (!s) continue;
    const blob = await getVideo(s.video.storageKey);
    if (!blob) continue;
    const v = document.createElement('video');
    const url = URL.createObjectURL(blob);
    v.muted = true;
    v.playsInline = true;
    v.src = url;
    await new Promise<void>((res, rej) => {
      v.onloadeddata = () => res();
      v.onerror = () => rej(new Error('video'));
    });
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext('2d')!;
    for (const l of rows) {
      await new Promise<void>((res) => {
        v.onseeked = () => res();
        v.currentTime = l.mediaTime;
      });
      ctx.drawImage(v, 0, 0);
      const jpg = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/jpeg', 0.92));
      const name = `${sid}_${l.frame}`;
      files[`images/${name}.jpg`] = [new Uint8Array(await jpg.arrayBuffer()), { level: 0 }];
      const long = Math.max(canvas.width, canvas.height);
      const bw = (l.boxSize * long) / canvas.width;
      const bh = (l.boxSize * long) / canvas.height;
      files[`labels/${name}.txt`] = strToU8(`0 ${l.x.toFixed(6)} ${l.y.toFixed(6)} ${bw.toFixed(6)} ${bh.toFixed(6)}\n`);
      onProgress?.(++done, labels.length);
    }
    URL.revokeObjectURL(url);
  }
  files['data.yaml'] = strToU8('path: .\ntrain: images\nval: images\nnames:\n  0: club_head\n');
  return new Blob([zipSync(files) as BlobPart], { type: 'application/zip' });
}
