// 下載 MediaPipe 姿態模型到 public/models（讓網站可離線使用）
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const models = [
  {
    url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
    out: 'public/models/pose_landmarker_full.task',
  },
  {
    url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task',
    out: 'public/models/pose_landmarker_heavy.task',
  },
];

mkdirSync('public/models', { recursive: true });
for (const m of models) {
  if (existsSync(m.out)) {
    console.log(`skip ${m.out}`);
    continue;
  }
  const res = await fetch(m.url);
  if (!res.ok) throw new Error(`${m.url} -> ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(m.out));
  console.log(`saved ${m.out}`);
}
