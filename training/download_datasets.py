"""從 Roboflow Universe 下載公開的桿頭標註資料集（YOLO 格式）。

需要環境變數 ROBOFLOW_API_KEY（免費帳號即可，於 https://app.roboflow.com/settings/api 取得）。

用法：
    python download_datasets.py            # 下載 datasets.yaml 內所有資料集
    python download_datasets.py --list     # 只列出各資料集的版本與類別，不下載
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).parent
RAW_DIR = ROOT / "datasets" / "raw"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=ROOT / "datasets.yaml", type=Path)
    ap.add_argument("--list", action="store_true", help="只列出資訊，不下載")
    ap.add_argument("--format", default="yolov8", help="Roboflow 匯出格式（YOLOv8 與 YOLO11 標註格式相同）")
    args = ap.parse_args()

    api_key = os.environ.get("ROBOFLOW_API_KEY")
    if not api_key:
        sys.exit("請先設定環境變數 ROBOFLOW_API_KEY")

    from roboflow import Roboflow

    cfg = yaml.safe_load(args.config.read_text(encoding="utf-8"))
    rf = Roboflow(api_key=api_key)
    RAW_DIR.mkdir(parents=True, exist_ok=True)

    for ds in cfg["datasets"]:
        ws, slug = ds["workspace"], ds["project"]
        name = f"{ws}__{slug}"
        try:
            project = rf.workspace(ws).project(slug)
            version_no = ds.get("version")
            if not version_no:
                versions = project.versions()
                if not versions:
                    print(f"[skip] {name}: 沒有可下載的版本")
                    continue
                version_no = max(int(str(v.version).split("/")[-1]) for v in versions)
            version = project.version(int(version_no))
            classes = getattr(project, "classes", None)
            print(f"[info] {name} v{version_no} classes={classes}")
            if args.list:
                continue
            dest = RAW_DIR / f"{name}-v{version_no}"
            if dest.exists():
                print(f"[skip] 已存在 {dest}")
                continue
            version.download(args.format, location=str(dest))
            print(f"[ok] {dest}")
        except Exception as e:  # noqa: BLE001 - 單一資料集失敗不中斷其他下載
            print(f"[error] {name}: {e}")


if __name__ == "__main__":
    main()
