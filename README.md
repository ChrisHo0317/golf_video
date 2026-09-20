# SwingLab — 高爾夫揮桿分析

在手機瀏覽器分析高爾夫揮桿影片：追蹤人體姿態與桿頭軌跡，並把量化數據與軌跡疊加在影片上。
網站是部署在 GitHub Pages 的純靜態網站，**所有運算都在使用者裝置上完成，影片與分析紀錄不會上傳到任何伺服器**。

- 網站：https://chrisho0317.github.io/golf_video/
- 版本：v0.0.1（MVP，支援後方視角 Down-the-line）
- 計畫書：[PLAN.md](PLAN.md)

---

## 功能

| 類別 | 內容 |
|---|---|
| 影片輸入 | 選擇或直接拍攝影片，可裁切分析範圍，支援慢動作倍率設定，自動校正 iPhone 影片旋轉 |
| 姿態分析 | MediaPipe Pose（33 個關鍵點，含 3D 座標），標準／高精度兩種模型 |
| 桿頭追蹤 | YOLO11n 桿頭偵測；沒有模型或模型沒抓到時，用影像偵測細直線找桿身（不需訓練，允許偏離雙手中心，並排除靜態背景線），再沿桿身逐段追蹤到末端（以線段平均對比抵抗草地／墊子紋理，並逐步修正角度），最後以區域分割（門檻取自桿身自身對比，並依明暗方向排除旁邊的球）取桿頭中心。每格保留多個候選，以動態規劃從整段影片挑出最連續的路徑，連續性同時考慮「桿身跟著手臂轉」與「桿身滯後」兩種運動；再用等加速度模型做前向卡爾曼加反向 RTS 平滑（前後慣性），推估缺漏格並剔除殘差過大的量測 |
| 揮桿階段 | 自動切分準備、起桿、頂點、擊球、收桿，可手動修正 |
| 慣性預測 | 以桿頭目前與前兩格的位置計算速度、加速度，推估下一格位置並顯示預測誤差；路徑選擇時也以慣性外推作為優先的運動模型 |
| 疊加圖層 | 14 種圖層可個別開關並調整顏色與透明度：骨架、桿頭軌跡（依速度著色）、桿頭慣性預測、桿身線、手部軌跡、頭部位移、臀部位移、脊椎角度、揮桿平面、肩線、髖線、階段標記、旋轉儀表、參考格線 |
| 曲線 | 速度、位移、旋轉、姿勢四組時序圖，與影片同步，點選圖表可跳到該格 |
| 數據 | 節奏比、桿頭／手部速度、擊球前接近路徑、下桿是否由外側切入、脊椎角變化、提早伸展、頭部位移、肩髖旋轉與 X-Factor 等，附燈號與文字建議 |
| 揮桿前後對照 | 頭部、臀部、雙手、桿頭在準備、頂點、擊球、收桿四個時間點的位移 |
| 手動修正 | 點選畫面修正桿頭位置，修正結果會存成模型訓練資料 |
| 儲存 | IndexedDB（分析資料）＋ OPFS（影片），可收藏、刪除、zip 備份與還原 |
| 匯出 | 截圖 PNG、JSON、CSV、帶軌跡的影片、YOLO 格式訓練資料 |
| 其他 | 繁中／英文即時切換、PWA 可加入主畫面並離線使用、公制單位 |

## 拍攝建議（後方視角）

1. 手機放在目標線延長線上、球員正後方約 3–4 公尺，並使用腳架。
2. 鏡頭高度在腰部到手部之間，保持水平。
3. 畫面要包含頂點時的桿頭與球的位置。
4. 盡量使用 120／240 fps 慢動作，並在光線充足的地方拍攝。

> 數據是從單一 2D 影片估算，會受拍攝角度影響。建議每次用相同條件拍攝，比較數據的變化趨勢。

## 使用方式

1. **新增**：選擇影片 → 拖曳選出揮桿片段 → 填寫慣用手、身高、球桿 → 開始分析。
2. **檢視**：播放或逐格瀏覽；右上角「圖層」可開關各軌跡，「修正桿頭」可手動修正桿頭位置。
3. **分頁**：曲線／數據／階段（手動調整）／筆記（標題、備註、匯出）。
4. **設定**：語言、姿態模型、預設拍攝資料、儲存空間、備份還原、匯出訓練資料。

## 開發

需求：Node.js 22 以上

```bash
npm install          # 安裝套件，並自動把 wasm 複製到 public/wasm
npm run fetch-models # （選用）下載 MediaPipe 姿態模型到 public/models；未下載時改從 Google CDN 載入
npm run dev          # http://localhost:5173
npm test             # 單元測試（Vitest）
npm run build        # 產生 dist/
```

### 技術架構

- React 18 + TypeScript + Vite，狀態管理用 Zustand
- `@mediapipe/tasks-vision`（姿態）、`onnxruntime-web`（桿頭，WebGPU 不可用時退回 WASM）
- WebCodecs + mp4box.js 逐格解碼，不支援時改用 `<video>` seek
- Canvas 2D 疊加、uPlot 圖表
- Dexie（IndexedDB）、OPFS、fflate（zip）
- react-i18next、vite-plugin-pwa

### 目錄

```
src/
├─ pages/              首頁、上傳、分析進度、檢視、設定
├─ components/         版面、時間軸、圖層面板、圖表、數據面板
├─ core/
│  ├─ video/           影片解析、逐格解碼、截圖
│  ├─ inference/       MediaPipe 姿態、YOLO 桿頭偵測、推論流程
│  ├─ tracking/        平滑濾波、卡爾曼濾波、桿頭多層追蹤
│  ├─ phases/          揮桿階段偵測
│  ├─ calibration/     像素與公尺換算
│  ├─ metrics/         量化指標與時序曲線
│  ├─ export/          JSON / CSV / 訓練資料匯出、分享
│  └─ pipeline.ts      後處理主流程
├─ overlay/            疊加圖層、繪製、匯出影片
├─ storage/            IndexedDB、OPFS、備份
├─ store/              使用者設定
└─ i18n/               繁中 / 英文
training/              桿頭模型訓練腳本（Python）
public/models/         模型檔（clubhead.onnx、clubhead.json）
```

## 部署（GitHub Pages）

推送到 `main` 後，`.github/workflows/deploy.yml` 會自動執行：測試 → 下載姿態模型 → 建置 → 部署。

第一次使用時，需要到 Repo 的 **Settings → Pages → Source** 選擇 **GitHub Actions**。

## 桿頭模型

1. 先用 Roboflow Universe 的公開標註資料訓練第一版。
2. 準確度不足時，用 App 內的手動修正累積自己的標註資料，再重新訓練。

詳細步驟見 [training/README.md](training/README.md)。訓練完成後，把 `public/models/clubhead.onnx` 和 `clubhead.json` 提交到 repo，網站就會載入模型。

## 目前限制與後續規劃

- [x] 後方視角 MVP
- [ ] 訓練並上線桿頭模型 v1
- [ ] 兩支揮桿比較
- [ ] 擊球目標線校正工具
- [ ] 正面視角（骨盆側移、重心轉移）
- [ ] 效能：背景執行緒推論、只推論雙手附近區域的最佳化

## 授權與致謝

- [MediaPipe](https://github.com/google-ai-edge/mediapipe)：Apache-2.0
- [Ultralytics YOLO](https://github.com/ultralytics/ultralytics)：AGPL-3.0（本專案為個人使用、原始碼公開）
- 桿頭訓練資料：Roboflow Universe 公開資料集（CC BY 4.0），來源列於 `training/datasets.yaml`
