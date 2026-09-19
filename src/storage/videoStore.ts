import Dexie from 'dexie';

/** 影片檔：優先 OPFS，不支援時存 IndexedDB */
const fallbackDb = new Dexie('swinglab-videos');
fallbackDb.version(1).stores({ videos: 'key' });
const videos = fallbackDb.table<{ key: string; blob: Blob }, string>('videos');

async function opfsDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (!navigator.storage?.getDirectory) return null;
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle('videos', { create: true });
  } catch {
    return null;
  }
}

export async function putVideo(key: string, blob: Blob): Promise<void> {
  const dir = await opfsDir();
  if (dir) {
    try {
      const fh = await dir.getFileHandle(key, { create: true });
      // Safari 的 createWritable 支援較晚，失敗時退回 IDB
      const w = await (fh as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
      await w.write(blob);
      await w.close();
      return;
    } catch {
      await dir.removeEntry(key).catch(() => undefined);
    }
  }
  await videos.put({ key, blob });
}

export async function getVideo(key: string): Promise<Blob | null> {
  const dir = await opfsDir();
  if (dir) {
    try {
      const fh = await dir.getFileHandle(key);
      const file = await fh.getFile();
      // Safari 寫入失敗時可能留下空檔，視為不存在
      if (file.size > 0) return file;
    } catch {
      // 不在 OPFS
    }
  }
  const row = await videos.get(key);
  return row?.blob?.size ? row.blob : null;
}

/**
 * 取得可直接給 <video> 播放的影片。
 * iOS Safari 對「從 IndexedDB 讀出的 Blob」建立的播放網址常播放失敗（WebKit 已知問題），
 * 且 OPFS 讀回的檔案沒有 MIME 類型；因此複製成記憶體中的新 Blob 並補上類型。
 */
export async function getPlayableVideo(key: string, mimeType?: string): Promise<Blob | null> {
  const blob = await getVideo(key);
  if (!blob) return null;
  const type = blob.type || mimeType || 'video/mp4';
  return new Blob([await blob.arrayBuffer()], { type });
}

export async function deleteVideo(key: string): Promise<void> {
  const dir = await opfsDir();
  await dir?.removeEntry(key).catch(() => undefined);
  await videos.delete(key);
}

export async function requestPersistence(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { usage: e.usage ?? 0, quota: e.quota ?? 0 } : null;
  } catch {
    return null;
  }
}
