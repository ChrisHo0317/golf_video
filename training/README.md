# 桿頭偵測模型訓練

單類別 `club_head` 的 YOLO11n 模型，匯出成 ONNX 後放進 `public/models/`，網站會自動載入。
沒有模型時，App 會以影像偵測桿身來定位桿頭；靜止或慢速時準確，但高速下桿的模糊影格仍容易出錯，所以建議訓練模型。

## 流程

```
公開資料集 ──download_datasets.py──┐
                                   ├─ merge_datasets.py ─ train.py ─ export_onnx.py ─ public/models/
App 手動標註 zip（app_labels/）────┘
```

## 1. 環境（Windows，Python 3.10–3.13）

```bash
cd training
python -m venv .venv
.venv\Scripts\activate
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
pip install -r requirements.txt
```

## 2. 下載公開資料集（v1）

到 https://app.roboflow.com/settings/api 取得免費 API Key：

```bash
set ROBOFLOW_API_KEY=你的金鑰
python download_datasets.py --list   # 先確認各資料集的類別名稱
python download_datasets.py
```

類別名稱對應規則在 `datasets.yaml` 的 `head_patterns`。`--list` 看到的類別若沒被對應到，就調整這裡的規則。

## 3. 合併 → 訓練 → 匯出

```bash
python merge_datasets.py
python train.py --name v1
python export_onnx.py --weights runs/clubhead/v1/weights/best.pt --version v1
```

驗收標準：驗證集 mAP50 ≥ 0.85。另外要在自己拍的影片上檢查，App 設定頁的「桿頭追蹤覆蓋率」應 ≥ 90%。

## 4. 準確度不足時：補上手動標註（v2、v3…）

1. 在 App 分析畫面按「修正桿頭」，點選模型抓錯或沒抓到的影格。重點放在下桿到擊球的模糊段。
2. 到「設定 → 匯出訓練資料」下載 zip，放進 `training/app_labels/`。
3. 以上一版權重接著訓練：

```bash
python merge_datasets.py --app-weight 3
python train.py --weights runs/clubhead/v1/weights/best.pt --name v2 --epochs 60
python export_onnx.py --weights runs/clubhead/v2/weights/best.pt --version v2
```

## 授權

- Roboflow Universe 資料集：CC BY 4.0（使用時需標示來源）
- Ultralytics YOLO：AGPL-3.0（個人使用、原始碼公開即可）
