"""匯出 ONNX 並安裝到網站 public/models/。

輸出：
    public/models/clubhead.onnx
    public/models/clubhead.json   （App 讀取的模型資訊）

用法：
    python export_onnx.py --weights runs/clubhead/v1/weights/best.pt --version v1
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).parent
MODELS = ROOT.parent / "public" / "models"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", required=True, type=Path)
    ap.add_argument("--version", required=True, help="例如 v1，會顯示在 App 設定頁")
    ap.add_argument("--imgsz", type=int, default=640)
    args = ap.parse_args()

    from ultralytics import YOLO

    model = YOLO(str(args.weights))
    # opset 17 + simplify；不含 NMS（App 端自行處理），固定輸入尺寸以利 WebGPU
    onnx_path = Path(model.export(format="onnx", imgsz=args.imgsz, opset=17, simplify=True, dynamic=False, nms=False))

    import onnxruntime as ort
    import numpy as np

    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    inp = sess.get_inputs()[0]
    out = sess.run(None, {inp.name: np.zeros((1, 3, args.imgsz, args.imgsz), dtype=np.float32)})[0]
    print(f"[check] input={inp.shape} output={out.shape}")
    assert out.shape[1] == 5, f"預期單類別輸出 [1, 5, N]，實際 {out.shape}"

    MODELS.mkdir(parents=True, exist_ok=True)
    shutil.copy(onnx_path, MODELS / "clubhead.onnx")
    names = model.names if isinstance(model.names, dict) else dict(enumerate(model.names))
    meta = {
        "version": f"yolo11n-clubhead-{args.version}",
        "inputSize": args.imgsz,
        "classNames": [names[k] for k in sorted(names)],
        "clubClass": 0,
    }
    (MODELS / "clubhead.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    size = (MODELS / "clubhead.onnx").stat().st_size / 1e6
    print(f"[ok] {MODELS / 'clubhead.onnx'} ({size:.1f} MB)")


if __name__ == "__main__":
    main()
