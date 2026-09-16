import { unzipSync, zipSync, strToU8, strFromU8, type Zippable } from 'fflate';
import type { SessionRecord } from '../types';
import { db, type LabelRow } from './db';
import { getVideo, putVideo } from './videoStore';

const FORMAT = 'swinglab-backup';

async function blobToU8(b: Blob) {
  return new Uint8Array(await b.arrayBuffer());
}

/** 匯出全部（或指定）紀錄為 zip */
export async function exportBackup(ids?: string[], includeVideos = true): Promise<Blob> {
  const sessions = ids ? ((await db.sessions.bulkGet(ids)).filter(Boolean) as SessionRecord[]) : await db.sessions.toArray();
  const files: Zippable = {};
  const manifest: { format: string; version: 1; exportedAt: number; sessions: unknown[] } = {
    format: FORMAT,
    version: 1,
    exportedAt: Date.now(),
    sessions: [],
  };
  for (const s of sessions) {
    const { thumbnail, ...rest } = s;
    manifest.sessions.push(rest);
    if (thumbnail) files[`thumbs/${s.id}.jpg`] = await blobToU8(thumbnail);
    const fr = await db.frames.get(s.id);
    if (fr) files[`frames/${s.id}.bin`] = [await blobToU8(fr.blob), { level: 0 }];
    if (includeVideos) {
      const v = await getVideo(s.video.storageKey);
      if (v) files[`videos/${s.video.storageKey}`] = [await blobToU8(v), { level: 0 }];
    }
  }
  const labels = await db.labels.toArray();
  files['labels.json'] = strToU8(JSON.stringify(labels));
  files['manifest.json'] = strToU8(JSON.stringify(manifest));
  const zipped = zipSync(files);
  return new Blob([zipped as BlobPart], { type: 'application/zip' });
}

/** 匯入備份：已存在的 id 會略過，回傳新增筆數 */
export async function importBackup(file: Blob): Promise<number> {
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const mf = entries['manifest.json'];
  if (!mf) throw new Error('invalid-backup');
  const manifest = JSON.parse(strFromU8(mf));
  if (manifest?.format !== FORMAT || !Array.isArray(manifest.sessions)) throw new Error('invalid-backup');
  let added = 0;
  for (const raw of manifest.sessions as SessionRecord[]) {
    if (typeof raw?.id !== 'string' || !raw.video?.storageKey || !/^[\w-]+$/.test(raw.video.storageKey)) continue;
    if (await db.sessions.get(raw.id)) continue;
    const thumb = entries[`thumbs/${raw.id}.jpg`];
    const frames = entries[`frames/${raw.id}.bin`];
    const video = entries[`videos/${raw.video.storageKey}`];
    if (video) await putVideo(raw.video.storageKey, new Blob([video as BlobPart], { type: raw.video.mimeType }));
    await db.sessions.put({ ...raw, thumbnail: thumb ? new Blob([thumb as BlobPart], { type: 'image/jpeg' }) : null });
    if (frames) await db.frames.put({ sessionId: raw.id, blob: new Blob([frames as BlobPart]) });
    added++;
  }
  const lb = entries['labels.json'];
  if (lb) {
    const labels = JSON.parse(strFromU8(lb)) as LabelRow[];
    if (Array.isArray(labels)) await db.labels.bulkPut(labels.filter((l) => typeof l?.id === 'string'));
  }
  return added;
}
