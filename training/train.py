"""訓練桿頭偵測模型（Ultralytics YOLO11n，單類別）。

用法：
    python train.py                         # 從 COCO 預訓練權重開始
    python train.py --weights runs/clubhead/v1/weights/best.pt --name v2   # 以上一版微調
"""

from __future__ import annotations

import argparse
from pathlib import Path

ROOT = Path(__file__).parent


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=ROOT / "datasets" / "merged" / "data.yaml", type=Path)
    ap.add_argument("--weights", default="yolo11n.pt")
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--epochs", type=int, default=120)
    ap.add_argument("--batch", type=int, default=16, help="8GB VRAM 建議 16；不足時改 8")
    ap.add_argument("--device", default=None, help="0 = 第一張 GPU，cpu = CPU")
    ap.add_argument("--name", default="v1")
    args = ap.parse_args()

    from ultralytics import YOLO

    model = YOLO(args.weights)
    model.train(
        data=str(args.data),
        imgsz=args.imgsz,
        epochs=args.epochs,
        batch=args.batch,
        device=args.device,
        project=str(ROOT / "runs" / "clubhead"),
        name=args.name,
        exist_ok=True,
        patience=30,
        # 桿頭小且常有動態模糊；App 端會以雙手為中心裁切，尺度變化較大
        scale=0.6,
        degrees=10,
        fliplr=0.5,  # 左右打者
        mosaic=1.0,
        close_mosaic=15,
        hsv_v=0.5,
        cos_lr=True,
    )
    metrics = model.val(data=str(args.data), imgsz=args.imgsz)
    print(f"mAP50={metrics.box.map50:.3f}  mAP50-95={metrics.box.map:.3f}")


if __name__ == "__main__":
    main()
