"""合併公開資料集與 App 匯出的手動標註，產生單一類別（club_head）的 YOLO 資料集。

輸入：
    datasets/raw/*            download_datasets.py 下載的 Roboflow 資料集
    app_labels/*.zip          App「設定 → 匯出訓練資料」產生的 zip（可放多個）
輸出：
    datasets/merged/{train,val}/{images,labels}
    datasets/merged/data.yaml

用法：
    python merge_datasets.py [--app-weight 3] [--neg-ratio 0.1]
"""

from __future__ import annotations

import argparse
import hashlib
import random
import re
import shutil
import zipfile
from pathlib import Path

import yaml

ROOT = Path(__file__).parent
RAW_DIR = ROOT / "datasets" / "raw"
APP_DIR = ROOT / "app_labels"
OUT = ROOT / "datasets" / "merged"
IMG_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def class_map(names: list[str], cfg: dict) -> set[int]:
    inc = [re.compile(p, re.I) for p in cfg["head_patterns"]]
    exc = [re.compile(p, re.I) for p in cfg["exclude_patterns"]]
    keep = set()
    for i, n in enumerate(names):
        if any(p.search(n) for p in inc) and not any(p.search(n) for p in exc):
            keep.add(i)
    return keep


def convert_line(line: str, keep: set[int]) -> str | None:
    """YOLO bbox 或多邊形標註 → club_head bbox；不相關類別回傳 None"""
    parts = line.split()
    if len(parts) < 5:
        return None
    cls = int(float(parts[0]))
    if cls not in keep:
        return None
    vals = list(map(float, parts[1:]))
    if len(vals) == 4:
        cx, cy, w, h = vals
    else:  # 多邊形
        xs, ys = vals[0::2], vals[1::2]
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        cx, cy, w, h = (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0
    if w <= 0 or h <= 0:
        return None
    return f"0 {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}"


class Writer:
    def __init__(self) -> None:
        self.seen: set[str] = set()
        self.count = {"train": 0, "val": 0, "neg": 0, "dup": 0}
        for s in ("train", "val"):
            (OUT / s / "images").mkdir(parents=True, exist_ok=True)
            (OUT / s / "labels").mkdir(parents=True, exist_ok=True)

    def add(self, split: str, img_bytes: bytes, ext: str, labels: list[str], name: str, copies: int = 1) -> None:
        digest = hashlib.sha1(img_bytes).hexdigest()
        if digest in self.seen:
            self.count["dup"] += 1
            return
        self.seen.add(digest)
        for c in range(copies if split == "train" else 1):
            stem = f"{name}_{digest[:10]}" + (f"_r{c}" if c else "")
            (OUT / split / "images" / f"{stem}{ext}").write_bytes(img_bytes)
            (OUT / split / "labels" / f"{stem}.txt").write_text("\n".join(labels) + ("\n" if labels else ""))
        self.count[split] += 1
        if not labels:
            self.count["neg"] += 1


def merge_raw(w: Writer, cfg: dict, neg_ratio: float, rnd: random.Random) -> None:
    for ds in sorted(p for p in RAW_DIR.glob("*") if p.is_dir()):
        data_yaml = ds / "data.yaml"
        if not data_yaml.exists():
            print(f"[skip] {ds.name}: 缺少 data.yaml")
            continue
        names = yaml.safe_load(data_yaml.read_text(encoding="utf-8"))["names"]
        if isinstance(names, dict):
            names = [names[k] for k in sorted(names)]
        keep = class_map(names, cfg)
        print(f"[raw] {ds.name}: classes={names} -> keep={sorted(keep)}")
        if not keep:
            continue
        for split_dir in ("train", "valid", "test"):
            img_dir = ds / split_dir / "images"
            if not img_dir.exists():
                continue
            split = "train" if split_dir == "train" else "val"
            for img in img_dir.iterdir():
                if img.suffix.lower() not in IMG_EXT:
                    continue
                lbl = ds / split_dir / "labels" / f"{img.stem}.txt"
                lines = lbl.read_text().splitlines() if lbl.exists() else []
                out = [x for x in (convert_line(l, keep) for l in lines) if x]
                if not out and rnd.random() > neg_ratio:
                    continue
                w.add(split, img.read_bytes(), img.suffix.lower(), out, ds.name[:24])


def merge_app(w: Writer, weight: int) -> None:
    for z in sorted(APP_DIR.glob("*.zip")):
        with zipfile.ZipFile(z) as zf:
            files = set(zf.namelist())
            for name in files:
                if not name.startswith("images/"):
                    continue
                stem = Path(name).stem
                lbl = f"labels/{stem}.txt"
                if lbl not in files:
                    continue
                session = stem.rsplit("_", 1)[0]
                # 以影片為單位切分，避免同一支影片同時出現在 train 與 val
                split = "val" if int(hashlib.md5(session.encode()).hexdigest(), 16) % 5 == 0 else "train"
                lines = [l for l in zf.read(lbl).decode().splitlines() if l.strip()]
                w.add(split, zf.read(name), Path(name).suffix.lower(), lines, f"app_{stem}", copies=weight)
        print(f"[app] {z.name}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--app-weight", type=int, default=3, help="App 手動標註在訓練集的重複次數（提高自己拍攝環境的權重）")
    ap.add_argument("--neg-ratio", type=float, default=0.1, help="保留無桿頭影像作為負樣本的比例")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    cfg = yaml.safe_load((ROOT / "datasets.yaml").read_text(encoding="utf-8"))
    if OUT.exists():
        shutil.rmtree(OUT)
    w = Writer()
    rnd = random.Random(args.seed)
    merge_raw(w, cfg, args.neg_ratio, rnd)
    merge_app(w, args.app_weight)

    (OUT / "data.yaml").write_text(
        yaml.safe_dump({"path": str(OUT.resolve()), "train": "train/images", "val": "val/images", "names": {0: "club_head"}}, allow_unicode=True),
        encoding="utf-8",
    )
    print(f"[done] {w.count}")
    if w.count["val"] == 0:
        print("[warn] 驗證集為空，請確認資料集是否包含 valid/test")


if __name__ == "__main__":
    main()
