import { zipSync, strToU8, type Zippable } from 'fflate';
import { db } from '../../storage/db';
import { getVideo } from '../../storage/videoStore';
import { loadVideo, seekVideo, withTimeout } from '../video/videoElement';

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
    const { video: v, dispose } = await loadVideo(blob);
    try {
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext('2d')!;
    for (const l of rows) {
      await seekVideo(v, l.mediaTime);
      ctx.drawImage(v, 0, 0);
      const jpg = await withTimeout(new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.92)), 5000, null);
      if (!jpg) continue;
      const name = `${sid}_${l.frame}`;
      files[`images/${name}.jpg`] = [new Uint8Array(await jpg.arrayBuffer()), { level: 0 }];
      const long = Math.max(canvas.width, canvas.height);
      const bw = (l.boxSize * long) / canvas.width;
      const bh = (l.boxSize * long) / canvas.height;
      files[`labels/${name}.txt`] = strToU8(`0 ${l.x.toFixed(6)} ${l.y.toFixed(6)} ${bw.toFixed(6)} ${bh.toFixed(6)}\n`);
      onProgress?.(++done, labels.length);
    }
    } finally {
      dispose();
    }
  }
  files['data.yaml'] = strToU8('path: .\ntrain: images\nval: images\nnames:\n  0: club_head\n');
  return new Blob([zipSync(files) as BlobPart], { type: 'application/zip' });
}
