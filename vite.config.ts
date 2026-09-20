import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages 部署於 /<repo>/ 之下，由 CI 設定 BASE_PATH
const base = process.env.BASE_PATH ?? '/';

import pkg from './package.json' with { type: 'json' };

/** 開發用：讓瀏覽器端的準確度評估把結果寫到 00_data/eval/（僅開發伺服器，檔名限制為英數與 . _ -） */
const devSave = (): Plugin => ({
  name: 'dev-save',
  apply: 'serve',
  configureServer(server) {
    // onnxruntime-web 會動態 import public/wasm 下的 .mjs，Vite 開發伺服器會補上 ?import 而失敗；
    // 這裡把查詢字串去掉，直接回傳原檔
    server.middlewares.use((req, _res, next) => {
      if (req.url?.startsWith('/wasm/') && req.url.includes('?')) req.url = req.url.split('?')[0];
      next();
    });
    server.middlewares.use('/__dev/save', (req, res) => {
      const name = new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? '';
      if (req.method !== 'POST' || !/^[\w.-]+$/.test(name)) {
        res.statusCode = 400;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const dir = resolve(process.cwd(), '00_data/eval');
        mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(dir, name), Buffer.concat(chunks));
        res.end('ok');
      });
    });
  },
});

export default defineConfig({
  base,
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    react(),
    devSave(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Golf Swing Analyzer',
        short_name: 'SwingLab',
        description: '在手機上分析高爾夫揮桿影片',
        theme_color: '#0f5132',
        background_color: '#0b1210',
        display: 'standalone',
        start_url: '.',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
      },
      workbox: {
        // App shell 預快取；模型與 wasm 較大，首次使用時再快取
        globPatterns: ['**/*.{js,css,html,svg,webmanifest}'],
        globIgnores: ['**/wasm/**', '**/models/**'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => /\/(wasm|models)\//.test(url.pathname),
            handler: 'CacheFirst',
            options: { cacheName: 'ml-assets', expiration: { maxEntries: 30 } },
          },
          {
            urlPattern: ({ url }) => url.hostname === 'storage.googleapis.com',
            handler: 'CacheFirst',
            options: { cacheName: 'ml-remote', expiration: { maxEntries: 10 } },
          },
        ],
      },
    }),
  ],
  // 使用外部 wasm（public/wasm/ort），避免把 26MB wasm 打包進 assets
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm'] },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: { chunkSizeWarningLimit: 1500 },
});
