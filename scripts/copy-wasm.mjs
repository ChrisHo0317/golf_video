// 將 MediaPipe 與 onnxruntime-web 的 wasm 檔複製到 public/，讓網站可離線、不依賴 CDN
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const targets = [
  { from: 'node_modules/@mediapipe/tasks-vision/wasm', to: 'public/wasm/mediapipe', filter: (f) => /^vision_wasm(_nosimd)?_internal\.(js|wasm)$/.test(f) },
  {
    from: 'node_modules/onnxruntime-web/dist',
    to: 'public/wasm/ort',
    filter: (f) => /^ort-wasm-simd-threaded\.asyncify\.(wasm|mjs)$/.test(f),
  },
];

for (const t of targets) {
  const src = join(root, t.from);
  if (!existsSync(src)) continue;
  const dst = join(root, t.to);
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(src)) {
    if (t.filter(f)) cpSync(join(src, f), join(dst, f));
  }
  console.log(`[copy-wasm] ${t.from} -> ${t.to}`);
}
