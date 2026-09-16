import Dexie, { type EntityTable } from 'dexie';
import type { FrameData, FramesRecord, SessionRecord } from '../types';
import { decodeFrames, encodeFrames } from './frameCodec';
import { deleteVideo } from './videoStore';

interface SettingRow {
  key: string;
  value: unknown;
}

/** 手動標註的桿頭（供匯出訓練資料） */
export interface LabelRow {
  id: string; // `${sessionId}:${frame}`
  sessionId: string;
  frame: number;
  mediaTime: number;
  x: number; // 0..1
  y: number;
  boxSize: number; // 0..1（相對於長邊）
  createdAt: number;
}

class SwingDB extends Dexie {
  sessions!: EntityTable<SessionRecord, 'id'>;
  frames!: EntityTable<FramesRecord, 'sessionId'>;
  settings!: EntityTable<SettingRow, 'key'>;
  labels!: EntityTable<LabelRow, 'id'>;

  constructor() {
    super('swinglab');
    this.version(1).stores({
      sessions: 'id, createdAt',
      frames: 'sessionId',
      settings: 'key',
      labels: 'id, sessionId, createdAt',
    });
  }
}

export const db = new SwingDB();

export async function saveSession(s: SessionRecord, frames?: FrameData) {
  // Dexie 交易內不可 await 非 IDB 的 Promise，因此先壓縮再寫入
  const blob = frames ? await encodeFrames(frames) : null;
  await db.transaction('rw', db.sessions, db.frames, async () => {
    await db.sessions.put({ ...s, updatedAt: Date.now() });
    if (blob) await db.frames.put({ sessionId: s.id, blob });
  });
}

export async function loadFrames(sessionId: string): Promise<FrameData | null> {
  const row = await db.frames.get(sessionId);
  return row ? decodeFrames(row.blob) : null;
}

export async function deleteSession(id: string) {
  const s = await db.sessions.get(id);
  await db.transaction('rw', db.sessions, db.frames, db.labels, async () => {
    await db.sessions.delete(id);
    await db.frames.delete(id);
    await db.labels.where('sessionId').equals(id).delete();
  });
  if (s) await deleteVideo(s.video.storageKey);
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key);
  return row ? (row.value as T) : fallback;
}

export async function setSetting(key: string, value: unknown) {
  await db.settings.put({ key, value });
}
