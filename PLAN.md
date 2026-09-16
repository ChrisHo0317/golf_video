# 高爾夫揮桿分析網站 — 實作計畫書

> 版本：v1.1　日期：2026-09-16
> 部署目標：GitHub Pages（純靜態網站，無後端）
> 已確認決策見第 19 章；MVP 以**後方視角**為主，規格見第 21 章

---

## 1. 專案目標

| 項目 | 說明 |
|---|---|
| 核心功能 | 使用者上傳揮桿影片 → 瀏覽器端分析人體姿態與桿頭 → 疊加軌跡於影片 → 提供量化數據與曲線圖 |
| 資料儲存 | 所有影片與分析結果只存在使用者手機／瀏覽器本機，不上傳任何伺服器 |
| 軌跡顯示 | 各類軌跡（骨架、桿頭、身體旋轉、重心位移…）可個別開關 |
| 使用裝置 | 手機優先（iOS Safari / Android Chrome），桌機相容 |

### 1.1 關鍵限制與對應決策

| 限制 | 影響 | 決策 |
|---|---|---|
| GitHub Pages 只能放靜態檔 | 無法在伺服器跑 AI 推論 | 全部推論在瀏覽器端執行（WASM / WebGL / WebGPU） |
| GitHub Pages 不能自訂 HTTP Header | 無法原生啟用 `SharedArrayBuffer`（多執行緒 WASM 需要 COOP/COEP） | 預設用單執行緒 + WebGPU/WebGL；需要多執行緒時用 `coi-serviceworker` 注入 Header |
| 單檔 100 MB 上限 | 模型檔不能太大 | 模型控制在 30 MB 以內（量化後），用 Git LFS 以外的方式直接放 `public/models` |
| 手機效能有限 | 即時分析會卡 | 採「離線逐格分析 + 快取結果」，播放時只讀快取，不重算 |
| iOS Safari 儲存可能被清除 | 分析紀錄遺失 | 申請 `navigator.storage.persist()`、引導加入主畫面（PWA）、提供匯出／匯入備份 |

---

## 2. 技術選型

| 層級 | 技術 | 理由 |
|---|---|---|
| 建置工具 | Vite + TypeScript | 快速、靜態輸出、易部署到 Pages |
| UI 框架 | React 18 + Zustand（狀態管理） | 生態系完整；Zustand 輕量 |
| UI 元件 | Tailwind CSS + Radix UI（或 shadcn/ui） | 手機版面好調整 |
| 人體姿態 | **MediaPipe Tasks Vision – PoseLandmarker（Heavy / Full）** | 33 個關鍵點 + 3D world landmarks，瀏覽器端 GPU 推論 |
| 桿頭偵測 | **自訓 YOLO11n / YOLOv8n（ONNX）+ onnxruntime-web（WebGPU→WASM 降級）** | 桿頭小且模糊，需專用模型 |
| 影像處理輔助 | OpenCV.js（光流、差分，選用） | 模型失敗時的補強追蹤 |
| 影片逐格解碼 | WebCodecs `VideoDecoder` + `mp4box.js`；降級用 `requestVideoFrameCallback` / seek | 精準取得每一格與時間戳 |
| 疊加繪圖 | Canvas 2D（MVP）→ 可升級 PixiJS/WebGL | 軌跡量大時效能較好 |
| 數據圖表 | uPlot（時序曲線，高效）+ Chart.js（雷達／長條） | uPlot 對上千點很流暢 |
| 本機資料庫 | IndexedDB（Dexie.js） | 儲存分析結果、設定 |
| 影片檔儲存 | OPFS（Origin Private File System），降級存 IndexedDB Blob | 大檔案效能較好 |
| 背景運算 | Web Worker + Comlink | 推論不卡 UI |
| PWA | vite-plugin-pwa（Workbox） | 離線使用、加入主畫面、延長儲存保存 |
| 多語系 | react-i18next（zh-TW / en，可即時切換） | 字串集中管理，單位與數字格式用 `Intl` |
| 輸出影片 | WebCodecs `VideoEncoder` + `mp4-muxer`；降級 `MediaRecorder` | 匯出帶軌跡的影片 |
| 測試 | Vitest（單元）、Playwright（E2E） | |
| CI/CD | GitHub Actions → `gh-pages` 分支 / Pages Artifact | push 即部署 |

---

## 3. 系統架構

### 3.1 整體流程（文字說明）

1. **上傳**：使用者選擇或拍攝影片 → 讀取中繼資料（解析度、FPS、長度、旋轉角度）→ 存入 OPFS。
2. **設定**：使用者填寫拍攝視角（正面 Face-on／後方 Down-the-line）、慣用手（右／左）、身高（用於尺度換算）、球桿種類。
3. **裁切（選用）**：使用者拖拉時間軸選出揮桿片段，減少運算量。
4. **逐格分析（Worker）**：
   - 解碼影格 → 縮放至長邊 640 px
   - 姿態模型 → 33 點 2D + 3D 座標
   - 桿頭模型 → 桿頭 bounding box 與信心值
   - 進度條即時回報
5. **後處理**：
   - 平滑濾波（One Euro Filter / Savitzky–Golay）
   - 桿頭缺漏補點（卡爾曼濾波 + 手部錨點約束 + 樣條插值）
   - 揮桿階段自動切分
   - 計算所有量化指標
6. **儲存**：分析結果（逐格座標 + 指標 + 階段）寫入 IndexedDB。
7. **播放與顯示**：影片播放時依 `currentTime` 找到對應影格資料 → Canvas 繪製已開啟的圖層；下方同步顯示曲線與數據卡。
8. **歷史／比較／匯出**：瀏覽歷史紀錄、雙影片比較、匯出 JSON/CSV/PNG/MP4。

### 3.2 模組劃分

```
src/
├─ app/                  # 路由、版面、全域 Provider
├─ pages/
│  ├─ Home/              # 歷史紀錄列表
│  ├─ Upload/            # 上傳 + 拍攝設定 + 裁切
│  ├─ Analyze/           # 分析進度
│  ├─ Viewer/            # 影片 + 疊加 + 圖表 + 數據
│  ├─ Compare/           # 雙揮桿比較
│  └─ Settings/          # 單位、預設圖層、儲存管理、備份
├─ core/
│  ├─ video/             # 解碼、影格擷取、中繼資料、旋轉校正
│  ├─ inference/         # pose.worker.ts, club.worker.ts, 模型載入
│  ├─ tracking/          # 卡爾曼濾波、One Euro、插值、離群值剔除
│  ├─ phases/            # 揮桿階段偵測
│  ├─ metrics/           # 各項指標計算（純函式，可單元測試）
│  ├─ calibration/       # 像素 ↔ 公尺換算
│  └─ export/            # JSON/CSV/PNG/MP4 匯出
├─ overlay/
│  ├─ layers/            # 每個圖層一個檔案（見第 6 章）
│  └─ OverlayRenderer.ts # 圖層調度、座標轉換
├─ charts/               # uPlot 包裝元件
├─ storage/              # Dexie schema、OPFS 存取、備份匯入匯出
├─ store/                # Zustand stores（播放狀態、圖層開關、設定）
└─ i18n/                 # 繁中 / 英文
public/
├─ models/               # pose_landmarker_full.task, clubhead_yolo11n.onnx
└─ wasm/                 # mediapipe / onnxruntime wasm 檔
```

---

## 4. 影片輸入規格與拍攝指引

### 4.1 支援格式
- MP4（H.264 / HEVC）、MOV（iPhone）、WebM
- 建議 FPS：**≥ 60**（240 fps 慢動作最佳，桿頭軌跡最清楚）
- 建議長度：≤ 15 秒（超過時要求使用者裁切）
- 解析度：任意，內部縮放至長邊 640 px 推論；顯示用原片

### 4.2 拍攝指引（App 內提供圖示說明）
- 手機固定（腳架），不可跟拍移動
- **正面（Face-on）**：鏡頭對準胸口高度，與目標線垂直 → 適合看重心位移、側移、頭部穩定、肩髖旋轉
- **後方（Down-the-line）**：鏡頭對準手部高度，沿目標線後方 → 適合看揮桿平面、桿頭路徑（內到外／外到內）
- 全身與球桿完整入鏡，揮桿頂點與收桿不可出框
- 光線充足、背景單純、快門越快越好（減少桿頭殘影）

### 4.3 需處理的技術細節
- iPhone 影片的旋轉 metadata（`tkhd` matrix）→ 解碼後手動旋轉
- 可變影格率（VFR）→ 一律以影格實際時間戳計算速度，不假設固定 FPS
- 慢動作影片：部分裝置 metadata 標示 30fps 但實際為 240fps → 讓使用者手動確認「慢動作倍率」

---

## 5. 分析演算法

### 5.1 人體姿態
- 模型：MediaPipe PoseLandmarker（`full` 為預設，高階裝置可選 `heavy`）
- 模式：`VIDEO` 模式（有時序追蹤，較穩定）
- 輸出：每格 33 點 `(x, y, z, visibility)` 正規化座標 + `worldLandmarks`（以髖部中心為原點的公尺座標）
- 後處理：
  - visibility < 0.5 的點標記為不可信，以前後格插值
  - One Euro Filter 去抖動（參數依 FPS 調整）
  - 左右手判斷：依使用者設定的慣用手決定「前導手臂（lead arm）」

### 5.2 桿頭追蹤（技術難點）

桿頭體積小、高速時嚴重模糊，單一方法不可靠，採**多層混合策略**：

| 層 | 方法 | 用途 |
|---|---|---|
| L1 | YOLO 桿頭偵測模型 | 主要來源，輸出 bbox 中心與信心值 |
| L2 | 手部錨點約束 | 桿頭必須位於以「雙手中點」為圓心、半徑 ≈ 球桿長度（像素）的環帶內；超出者視為誤判剔除 |
| L3 | 卡爾曼濾波（等加速度模型） | 平滑 + 預測缺漏格 |
| L4 | 殘影偵測（選用，OpenCV.js） | 高速段畫面差分找出線狀殘影，取末端點補強 |
| L5 | 使用者手動校正 | 在關鍵格（起始、頂點、擊球）點選桿頭位置，其餘以樣條插值重算 |

**模型訓練計畫（離線，本機或 Colab）：**
1. 資料：Roboflow Universe 公開高爾夫桿頭資料集 + 自行標註 1,000–3,000 張（含模糊桿頭）
2. 訓練：Ultralytics YOLO11n，輸入 640，單類別 `club_head`（可加 `grip`、`ball` 類別）
3. 資料增強：motion blur、亮度、左右翻轉（左打者）
4. 匯出：ONNX（opset 17）→ INT8/FP16 量化，目標 < 10 MB
5. 驗收：mAP50 ≥ 0.85；在測試影片中桿頭軌跡可用率 ≥ 90% 影格

> MVP 階段若模型尚未就緒，先以 L2 + L5（手部延伸 + 手動關鍵格）提供近似桿頭軌跡，並在 UI 標示「估算值」。

### 5.3 揮桿階段自動切分

以「前導手腕高度」「雙手速度」「桿頭位置」判斷：

| 階段 | 判斷規則 |
|---|---|
| Address（準備） | 影片開頭雙手速度持續接近 0 的區段最後一格 |
| Takeaway（起桿） | 雙手速度首次超過門檻 |
| Top（頂點） | 起桿後雙手高度最高點／桿頭水平速度方向反轉 |
| Downswing（下桿） | Top 之後至 Impact |
| Impact（擊球） | 下桿中雙手回到接近 Address 位置且桿頭速度最大的鄰近格；有球時以球開始移動為準 |
| Follow-through（送桿） | Impact 之後 |
| Finish（收桿） | 送桿後雙手速度再次接近 0 |

使用者可在時間軸上拖曳修正各階段標記，修正後重算指標。

### 5.4 尺度校正（像素 → 公尺）
- 方法 A（預設）：使用者輸入身高 → Address 時「腳踝到頭頂」像素高度換算（頭頂以鼻子上移比例估算）
- 方法 B：使用者輸入球桿長度 → Address 時手到桿頭像素距離換算
- 方法 C：`worldLandmarks` 的 3D 公尺座標直接使用（僅供旋轉角度，不用於絕對位移，準確度有限）
- UI 需標示：「數值為 2D 影像估算，受拍攝角度影響」

---

## 6. 疊加圖層（可個別開關）

| 圖層 ID | 名稱 | 內容 | 適用視角 |
|---|---|---|---|
| `skeleton` | 人體骨架 | 33 點連線 | 全部 |
| `clubPath` | 桿頭軌跡 | 桿頭歷史路徑，依速度漸層著色；可選「全程 / 殘影長度 N 格」 | 全部 |
| `clubShaft` | 桿身線 | 雙手中點 → 桿頭連線 | 全部 |
| `handPath` | 手部軌跡 | 雙手中點路徑 | 全部 |
| `hipCenterPath` | 骨盆位移軌跡 | 髖部中心路徑 + Address 基準點 | 正面 |
| `headPath` | 頭部位移軌跡 | 鼻子/頭部中心路徑 + 基準框 | 全部 |
| `comPath` | 重心軌跡（估算） | 依人體段質量比例加權的重心點 | 正面 |
| `shoulderLine` | 肩線 | 左右肩連線 + 角度標示 | 全部 |
| `hipLine` | 髖線 | 左右髖連線 + 角度標示 | 全部 |
| `rotationGauge` | 身體旋轉儀表 | 畫面角落顯示肩／髖旋轉角與 X-Factor 圓盤 | 全部 |
| `spineAngle` | 脊椎角度 | 髖中心 → 肩中心連線與垂直線夾角 | 後方 |
| `swingPlane` | 揮桿平面 | Address 時球 → 桿身延長線、球 → 肩部線 | 後方 |
| `phaseMarkers` | 階段標記 | 軌跡上標示 Top / Impact 等點 | 全部 |
| `referenceGrid` | 參考格線 | 垂直/水平輔助線 | 全部 |
| `ghost` | 殘影 | 關鍵階段的半透明骨架疊圖 | 全部 |

### 6.1 圖層設計
- 每個圖層實作共同介面：
  - `id`、`label`、`defaultEnabled`、`supportedViews`
  - `draw(ctx, frameIndex, data, style)`
  - 樣式參數：顏色、線寬、透明度、軌跡長度
- 圖層面板：開關、顏色選擇、「只顯示到目前時間 / 顯示全程」切換
- 預設組合（Preset）：「初學者」「位移分析」「桿頭路徑」「全部」
- 開關狀態存入 IndexedDB 的使用者設定，下次開啟保留

### 6.2 座標轉換
- 影片以 `object-fit: contain` 顯示 → 計算實際影像區域的 offset 與縮放比
- Canvas 使用 `devicePixelRatio` 提高清晰度
- 支援雙指縮放／平移時，Canvas 同步套用相同變換

---

## 7. 量化指標

### 7.1 位移類（揮桿前 → 揮桿後）

| 指標 | 計算方式 | 單位 | 呈現 |
|---|---|---|---|
| 骨盆側移（Hip Sway） | 髖中心 X 相對 Address 的位移 | cm | 時序曲線 + Top/Impact/Finish 數值 |
| 骨盆上下（Hip Lift） | 髖中心 Y 位移 | cm | 時序曲線 |
| 頭部位移 | 頭部中心 X/Y 位移 | cm | 時序曲線 + 最大值 |
| 重心轉移 | 重心 X 相對雙腳中點的比例（-100%＝後腳，+100%＝前腳） | % | 時序曲線 + 各階段數值 |
| 前後位移（Early Extension） | 後方視角髖部往球方向移動量 | cm | Address vs Impact |
| 手部位移 | 雙手中點路徑 | cm | 軌跡圖 |

**「揮桿前 / 揮桿後」對照表**：Address、Top、Impact、Finish 四個時間點的各部位座標差值，以表格 + 雷達圖呈現。

### 7.2 桿頭類

| 指標 | 計算方式 | 單位 |
|---|---|---|
| 桿頭速度曲線 | 相鄰格位移 / 時間差（平滑後） | m/s、mph |
| 最大桿頭速度 / 擊球時速度 | 曲線最大值 / Impact 格 | m/s、mph |
| 桿頭軌跡 | 全程座標序列 | — |
| 揮桿弧寬度 | 軌跡最左 ↔ 最右距離 | cm |
| 擊球路徑角度（後方視角） | Impact 前後 3 格的桿頭行進方向與目標線夾角（內到外 + / 外到內 −） | ° |
| 揮桿平面角度 | 桿身與地面夾角（Address、Top 前、Impact） | ° |
| 軌跡一致性（比較時） | 兩條軌跡正規化後的 DTW 距離 | 分數 |

### 7.3 旋轉類

| 指標 | 計算方式 | 單位 |
|---|---|---|
| 肩部旋轉角 | 3D world landmarks 肩線在水平面投影角，相對 Address | ° |
| 髖部旋轉角 | 同上，以髖線計算 | ° |
| X-Factor | 肩旋轉 − 髖旋轉（Top 時最大值） | ° |
| 旋轉速度 | 旋轉角微分 | °/s |
| 運動鏈順序（Kinematic Sequence） | 髖 → 肩 → 手臂 → 桿頭 角速度峰值出現的時間順序 | 順序 + ms 差 |
| 肩部傾斜 | 2D 肩線與水平夾角 | ° |
| 脊椎角維持 | Address 與 Impact 脊椎角差 | ° |

> 旋轉角以 MediaPipe 3D 座標估算，準確度有限；正面視角可另用 2D「肩寬縮短比例」反推旋轉角作為交叉驗證。

### 7.4 節奏與姿勢類

| 指標 | 計算方式 |
|---|---|
| 節奏比（Tempo） | 上桿時間 : 下桿時間（職業選手約 3:1） |
| 上桿 / 下桿時間 | 階段時間戳差 | 
| 前導手臂角度 | 肩–肘–腕夾角（Top 時是否打直） |
| 手腕屈角（Wrist Hinge） | 前臂與桿身夾角 |
| 膝蓋彎曲 | 髖–膝–踝夾角（Address、Impact） |
| 收桿平衡 | Finish 後 1 秒內重心／頭部晃動量 |

### 7.5 綜合評分（選用）
- 每項指標設定參考區間（依使用者程度：初學 / 中階 / 進階）
- 產出綠黃紅燈號與文字建議（規則式，不需 AI 後端）
- 例：「頭部側移 12 cm，超過建議值 5 cm，建議上桿時保持頭部穩定」

---

## 8. 數據呈現介面（Viewer 頁）

### 8.1 版面（手機直向）
1. **影片區**（上方）：影片 + Canvas 疊加；右上角「圖層」按鈕
2. **播放控制**：播放/暫停、逐格前後、速度（0.1x–1x）、階段快速跳轉鈕（Address / Top / Impact / Finish）
3. **時間軸**：可拖曳，標示各階段色塊
4. **分頁**：
   - 「曲線」：位移 / 速度 / 旋轉角 時序圖，游標與影片同步（點圖表可跳到該格）
   - 「數據」：指標卡片 + 揮桿前後對照表
   - 「軌跡圖」：純軌跡平面圖（不含影片），可放大
   - 「建議」：規則式評語
5. 桌機版：影片左、圖表右並排

### 8.2 同步機制
- 使用 `requestVideoFrameCallback` 取得精確顯示時間 → 以二分搜尋找最近影格索引
- 全域 store 保存 `currentFrameIndex`，影片、Canvas、圖表游標皆訂閱此值

---

## 9. 本機資料儲存

### 9.1 IndexedDB Schema（Dexie）

```
db.version(1).stores({
  sessions: 'id, createdAt, clubType, viewAngle, favorite',
  frames:   'sessionId',          // 整包逐格資料（壓縮後）
  settings: 'key',
});
```

**sessions**
- `id`（UUID）、`createdAt`、`title`、`notes`、`tags`、`favorite`
- `video`: `{ opfsPath, durationMs, fps, width, height, rotation, slowMoFactor, trimStart, trimEnd }`
- `capture`: `{ viewAngle, handedness, heightCm, clubType, clubLengthCm }`
- `phases`: `{ address, takeaway, top, impact, finish }`（影格索引）
- `metrics`: 第 7 章所有指標數值
- `calibration`: `{ pxPerMeter, method }`
- `thumbnail`: Blob（Impact 格縮圖）
- `modelVersions`: `{ pose, club }`（模型更新時可提示重新分析）

**frames**（每個 session 一筆）
- `timestamps: Float64Array`
- `pose2d: Float32Array`（N × 33 × 3）
- `pose3d: Float32Array`（N × 33 × 3）
- `club: Float32Array`（N × 3：x, y, confidence）
- `clubSource: Uint8Array`（0=模型, 1=預測, 2=手動）
- 以 TypedArray 儲存並用 `CompressionStream('gzip')` 壓縮，10 秒 240fps 約 1–3 MB

### 9.2 影片檔
- 存 OPFS：`/videos/{sessionId}.mp4`
- 不支援 OPFS 的瀏覽器 → 存 IndexedDB Blob
- 設定頁提供「只保留分析資料、刪除原始影片」以節省空間（需確認）

### 9.3 儲存管理
- 首次使用呼叫 `navigator.storage.persist()`
- 設定頁顯示 `navigator.storage.estimate()` 用量
- **備份匯出**：將 sessions + frames + 影片打包成 `.zip`（fflate），透過 Web Share API 分享到檔案 App / 雲端硬碟
- **備份匯入**：選擇 zip 還原
- iOS 提示：「建議加入主畫面以避免資料被系統清除」

---

## 10. 匯出功能
- 單張截圖：影片格 + 疊加層 → PNG
- 數據：JSON（完整）、CSV（逐格座標、指標）
- 帶軌跡影片：逐格繪製至 OffscreenCanvas → `VideoEncoder` → `mp4-muxer` → MP4
- 分享：Web Share API（手機原生分享面板）

---

## 11. 雙揮桿比較（Phase 2）
- 選兩筆紀錄，並排或重疊（半透明）顯示
- 以 Impact 對齊時間軸，或以各階段做分段時間正規化
- 曲線圖疊加兩條線
- 指標差異表（本次 vs 上次 / vs 最佳紀錄）
- 可選擇以骨架大小做尺度正規化後重疊

---

## 12. PWA 與效能

### 12.1 PWA
- manifest：名稱、圖示、`display: standalone`、主題色
- Service Worker 預快取：App Shell、WASM、模型檔（首次載入後離線可用）
- 模型更新：版本化檔名 + 提示使用者重新整理

### 12.2 效能策略
- 推論在 Worker 中執行，UI 不阻塞
- 優先 WebGPU → WebGL → WASM 自動降級
- 推論輸入縮小至長邊 640 px；桿頭模型可只在「雙手周圍 ROI」裁切後推論以提高小物體辨識率
- 批次處理：每解碼一格立即推論並釋放 `VideoFrame`（避免記憶體爆掉）
- 分析結果快取，播放時零推論
- 預估效能（中階手機）：姿態 ~20–40 fps、桿頭 ~15–30 fps → 10 秒 240fps（2,400 格）約 1.5–3 分鐘；提供「每 N 格取樣」快速模式

### 12.3 相容性降級表

| 功能 | 首選 | 降級 |
|---|---|---|
| 解碼 | WebCodecs | `<video>` seek + `requestVideoFrameCallback` |
| 推論後端 | WebGPU | WebGL → WASM |
| 影片儲存 | OPFS | IndexedDB Blob |
| 影片匯出 | VideoEncoder | MediaRecorder（WebM） |
| 多執行緒 | coi-serviceworker | 單執行緒 |

---

## 13. 部署（GitHub Pages）

1. 建立 repo，`vite.config.ts` 設定 `base: '/<repo-name>/'`
2. 路由使用 `HashRouter`（避免 Pages 重新整理 404），或加 `404.html` 轉址
3. GitHub Actions workflow：
   - 觸發：push 到 `main`
   - 步驟：checkout → setup-node → `npm ci` → `npm run test` → `npm run build` → `actions/upload-pages-artifact` → `actions/deploy-pages`
4. Repo Settings → Pages → Source 選 GitHub Actions
5. 模型與 WASM 放 `public/`，確認單檔 < 100 MB、整站 < 1 GB
6. （選用）自訂網域 + HTTPS（相機與部分 API 需要安全來源）

---

## 14. 開發里程碑

| 階段 | 內容 | 產出 / 驗收標準 | 預估工時 |
|---|---|---|---|
| **M0 專案建置** | Vite+TS+React、ESLint/Prettier、Tailwind、GitHub Actions 部署 | Pages 上可看到空白首頁 | 1–2 天 |
| **M1 上傳與播放** | 上傳/拍攝、中繼資料、旋轉校正、裁切、逐格播放器 | 可逐格瀏覽 iPhone/Android 影片 | 3–4 天 |
| **M2 姿態分析** | MediaPipe Worker、逐格推論、進度條、平滑濾波 | 骨架穩定貼合人物 | 4–5 天 |
| **M3 疊加圖層系統** | 圖層介面、骨架/手部/頭部/髖部/肩髖線、圖層面板與開關 | 各圖層可獨立開關並保存設定 | 4–5 天 |
| **M4 階段偵測 + 尺度校正** | 自動分段、手動修正、身高校正 | 測試影片階段誤差 ≤ 3 格（60fps） | 3 天 |
| **M5 指標與圖表** | 位移、旋轉、節奏、姿勢指標；uPlot 同步游標；前後對照表 | 指標單元測試通過；圖表與影片同步 | 5–7 天 |
| **M6 桿頭追蹤 v1** | 手部延伸估算 + 手動關鍵格 + 樣條插值 | 可顯示估算桿頭軌跡 | 3 天 |
| **M7 桿頭模型** | 資料收集標註、YOLO 訓練、ONNX 量化、瀏覽器整合、卡爾曼 + 錨點約束 | 軌跡可用率 ≥ 90%；桿頭速度相關指標上線 | 10–15 天 |
| **M8 本機儲存** | Dexie、OPFS、歷史列表、搜尋/標籤/收藏、刪除確認 | 關閉瀏覽器後資料仍在 | 3–4 天 |
| **M9 PWA 與匯出** | 離線快取、備份 zip、PNG/CSV/JSON/MP4 匯出、Web Share | 離線可開啟並分析；可還原備份 | 4–5 天 |
| **M10 比較與建議** | 雙揮桿比較、規則式評分與建議 | 可並排／重疊比較 | 4–5 天 |
| **M11 測試與優化** | 跨裝置測試、效能調校、錯誤處理、i18n、無障礙 | 主流手機皆可完成分析流程 | 5 天 |

**MVP 範圍**：M0–M6 + M8（約 4–5 週）——姿態分析、位移/旋轉曲線、估算桿頭軌跡、圖層開關、本機儲存。
**完整版**：加上 M7、M9–M11（再約 5–6 週）。

---

## 15. 測試計畫

| 類型 | 內容 |
|---|---|
| 單元測試 | `core/metrics`、`core/tracking`、`core/phases` 全為純函式，用合成資料驗證（例如已知旋轉角的假座標） |
| 準確度測試 | 建立 20–30 支標註影片（人工標出各階段格數、桿頭位置），計算誤差 |
| E2E | Playwright：上傳 → 分析 → 開關圖層 → 重新整理後紀錄仍存在 |
| 裝置測試 | iPhone（Safari、PWA 模式）、Android Chrome 中低階機、桌機 Chrome/Edge/Safari |
| 效能測試 | 記錄各裝置每秒處理格數、記憶體峰值 |
| 儲存測試 | 空間不足、瀏覽器清除資料、備份還原 |

---

## 16. 風險與對策

| 風險 | 可能性 | 對策 |
|---|---|---|
| 桿頭高速模糊偵測不到 | 高 | 多層追蹤策略 + 手動校正 + 鼓勵高 FPS 拍攝 |
| 2D 影像的角度／位移誤差 | 高 | UI 明確標示估算；依視角只顯示可信指標；強調「趨勢比較」而非絕對值 |
| 手機推論太慢或記憶體不足 | 中 | ROI 裁切、取樣模式、逐格釋放 VideoFrame、降級後端 |
| iOS 儲存被清除 | 中 | persist()、PWA 引導、定期提醒備份 |
| iOS WebCodecs / HEVC 支援差異 | 中 | 降級 seek 解碼路徑；錯誤時提示轉檔 |
| 模型授權 | 低 | MediaPipe 為 Apache 2.0；Ultralytics YOLO 為 **AGPL-3.0** → 個人使用、公開 repo 即符合；未來若商用需購買授權或改用寬鬆授權模型 |
| 公開資料集授權 | 低 | 確認 Roboflow 資料集授權條款，必要時自行標註 |

---

## 17. 隱私與安全
- 影片與資料全程不離開使用者裝置，不使用任何分析追蹤服務（或僅用不含個資的匿名計數，並提供關閉選項）
- 靜態網站設定 CSP（透過 `<meta http-equiv>`）
- 匯入的備份檔做格式驗證，避免惡意資料
- 首頁說明隱私政策

---

## 18. 後續擴充方向
- 多角度同步（正面 + 後方兩支影片合併分析）
- 球的起飛方向偵測
- 以 AI（可選的使用者自備 API Key）產生教練式文字建議
- 目標揮桿範本（職業選手參考軌跡）疊圖
- 即時相機模式（低精度即時骨架預覽）

---

## 19. 決策紀錄（2026-09-16 確認）

| # | 項目 | 決定 | 理由／影響 |
|---|---|---|---|
| 1 | 前端框架 | **React 18 + TypeScript + Vite** | MediaPipe、onnxruntime-web、uPlot、Dexie 的範例與封裝最多；Worker + Comlink 搭配成熟 |
| 2 | 使用對象 | **個人使用** | 不需帳號系統、不需分析追蹤；YOLO（AGPL-3.0）可直接使用，repo 公開即符合授權 |
| 3 | 桿頭訓練資料 | 公開資料集起步 + **App 內建標註功能**累積自己的資料（見第 20 章） | |
| 4 | 單位 | **公制**（cm、m/s、°），速度另附 km/h | 設定頁保留單位切換欄位，但 MVP 只實作公制 |
| 5 | 語系 | **繁體中文 / English 可即時切換** | react-i18next；語系存於 settings，預設依瀏覽器語言 |
| 6 | MVP 視角 | **後方（Down-the-line）** | 圖層與指標優先順序改依後方視角（見第 21 章） |

---

## 20. 桿頭模型訓練資料說明

### 20.1 為什麼需要訓練資料
MediaPipe 只能辨識人體，**沒有現成模型能辨識「桿頭」**。要讓程式在每一格自動找到桿頭，必須自己訓練一個物件偵測模型（YOLO），而模型需要「範例答案」來學習：
- 從揮桿影片中抽出影格圖片
- 在每張圖上用方框把桿頭框起來（這個動作叫「標註」）
- 模型看過上千張「圖 + 方框」後，就能在新影片中自己找出桿頭

### 20.2 需要多少、要花多少時間
| 項目 | 數量／時間 |
|---|---|
| 影片 | 20–40 支後方視角揮桿（不同球桿、光線、衣著、場地） |
| 標註圖片 | 約 1,500–3,000 張（每支影片抽 50–80 格，重點抽下桿到擊球的模糊段） |
| 人工標註速度 | 約 3–5 秒 / 張 → 3,000 張約 3–4 小時 |
| 訓練 | Google Colab 免費 GPU 約 1–2 小時 |

### 20.3 取得方式（依序進行）
1. **公開資料集**：Roboflow Universe 上已有 golf club head 標註資料，可先訓練出 v0 模型（不需自己標註）。
2. **App 內建標註（省力做法）**：分析時模型抓不到或抓錯的格，本來就需要你手動點選修正（第 5.2 節 L5）。這些修正會自動存成標註資料，設定頁可「匯出訓練資料」（YOLO 格式 zip）。
3. **半自動標註**：用 v0 模型先預標，只需檢查、修正錯誤的框，速度快 3–5 倍。
4. **重新訓練**：累積數百張自己的資料後重新訓練 → 模型越來越適合你的拍攝環境（v1、v2…）。

### 20.4 你需要做的事
- 用手機（建議 120 / 240 fps 慢動作）從後方拍攝自己的揮桿，數量越多越好
- 分析後花幾分鐘修正抓錯的桿頭位置
- 其餘（抽格、格式轉換、訓練腳本、量化、部署）由專案內的 `training/` 腳本處理

### 20.5 專案新增目錄
```
training/
├─ extract_frames.py      # 從影片抽格（偏重高速段）
├─ merge_datasets.py      # 合併公開資料 + App 匯出資料
├─ train.ipynb            # Colab 訓練筆記本（Ultralytics YOLO11n）
├─ export_onnx.py         # 匯出 ONNX + FP16/INT8 量化
└─ README.md
```

---

## 21. 後方視角（Down-the-line）MVP 規格

### 21.1 拍攝規範（App 內圖示引導）
- 手機放在**目標線延長線上、球員正後方**，距離約 3–4 公尺
- 鏡頭高度約**腰部到手部**之間，鏡頭水平（App 用陀螺儀顯示水平儀，選用）
- 畫面需包含：頭頂上方（揮桿頂點桿頭）到腳底、球的位置
- 建議 120 / 240 fps

### 21.2 後方視角可信度較高的項目（MVP 優先）

| 優先 | 圖層 | 指標 |
|---|---|---|
| P0 | `clubPath` 桿頭軌跡 | 桿頭速度曲線、最大／擊球速度、**擊球路徑（內到外 / 外到內）** |
| P0 | `swingPlane` 揮桿平面 | Address 桿身平面角、Top 時桿身是否平行平面（Across / Laid-off）、下桿是否在平面上方（Over the top） |
| P0 | `handPath` 手部軌跡 | 手部高度、手部與身體距離 |
| P0 | `spineAngle` 脊椎角 | Address → Impact 脊椎前傾角變化 |
| P0 | `skeleton` 骨架 | 膝角、前導手臂角度 |
| P0 | `phaseMarkers` | 節奏比（上桿：下桿） |
| P1 | `hipDepthPath` 臀部線 | **提早伸展（Early Extension）**：臀部相對 Address 臀線往球方向的位移（cm） |
| P1 | `headPath` 頭部位移 | 頭部上下、前後位移（cm） |
| P1 | `shoulderLine` / `hipLine` | 肩、髖旋轉角（3D 座標估算）、X-Factor |
| P2 | `clubShaft` 桿身線 | 各階段桿身角度 |
| P2 | `ghost` 殘影 | Address / Top / Impact 疊圖 |

### 21.3 後方視角不適用（Phase 2 加入正面視角時再開放）
- 骨盆左右側移（Hip Sway）、重心左右轉移 → 需正面視角
- 上傳時若選擇「正面」，MVP 顯示「尚未支援」提示

### 21.4 後方視角的技術注意事項
- **擊球路徑判定**：需先取得目標線方向。預設假設目標線與畫面中心垂直線平行（鏡頭正對），另提供「在畫面上拖曳畫出目標線」校正工具
- **桿頭遮擋**：頂點時桿頭可能在頭部後方、擊球時可能被手遮住 → 依賴卡爾曼預測 + 手部錨點約束補點
- **深度方向誤差**：桿頭朝鏡頭方向移動時 2D 位移被低估 → 速度以「手部線速度 × 桿長比例」交叉估算，兩者差異過大時標示低信心
- **尺度校正**：後方視角身高仍可見，沿用身高換算；另提供「以球桿長度校正」

### 21.5 調整後 MVP 里程碑
M0 → M1 → M2 → M3（先做 P0 圖層）→ M4 → M6（手部延伸估算桿頭）→ M7（以公開資料集訓練 v0 模型，提前進 MVP，因後方視角的核心價值在桿頭路徑）→ M5（P0/P1 指標）→ M8 → i18n 雙語 → 發布 MVP
預估：**5–6 週**
