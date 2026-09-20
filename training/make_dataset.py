"""從 00_data 的影片與標記產生 YOLO 訓練資料（單類別 club_head）。

裁切方式與 App 推論時一致：先把影格縮到最長邊 960，再以「雙手為中心、邊長 5.5 倍軀幹」
的正方形裁切（超出畫面處填灰 114），最後縮放到 640。桿頭框邊長取 0.13 倍手到桿頭距離。

輸入：
    00_data/<name>.mp4
    00_data/labels/<name>_clubhead_labels.json   人工標記（status=visible 才用）
    00_data/eval/<name>_pred.json                推論結果（提供雙手位置與軀幹長度）
    accept.json（選用）                          {"<name>": [[起, 迄], ...]} 目視確認過的自動標記範圍

輸出：
    training/datasets/local/{train,val}/{images,labels}
    training/datasets/local/data.yaml

用法：
    python make_dataset.py                       # 只用人工標記
    python make_dataset.py --accept accept.json  # 另外加入確認過的自動標記
    python make_dataset.py --val 811526255.326530,811526255.783496
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).parent
DATA = ROOT.parent / "00_data"
MAX_SIDE = 960  # App 分析時的最長邊
INPUT = 640  # 模型輸入尺寸
BOX_K = 0.13  # 桿頭框邊長 / 手到桿頭距離
PAD = 114  # 與 App 相同的灰底


def roi_of(hx: float, hy: float, torso: float, w: int, h: int):
    size = min(max(w, h), torso * 5.5)
    return hx - size / 2, hy - size / 2, size


def crop(img: np.ndarray, x: float, y: float, size: float) -> np.ndarray:
    out = np.full((INPUT, INPUT, 3), PAD, np.uint8)
    s = INPUT / size
    x0, y0 = int(round(x)), int(round(y))
    sx0, sy0 = max(0, x0), max(0, y0)
    sx1, sy1 = min(img.shape[1], int(round(x + size))), min(img.shape[0], int(round(y + size)))
    if sx1 <= sx0 or sy1 <= sy0:
        return out
    patch = img[sy0:sy1, sx0:sx1]
    dw, dh = max(1, int(round(patch.shape[1] * s))), max(1, int(round(patch.shape[0] * s)))
    patch = cv2.resize(patch, (dw, dh), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR)
    ox, oy = int(round((sx0 - x) * s)), int(round((sy0 - y) * s))
    ox2, oy2 = min(INPUT, ox + dw), min(INPUT, oy + dh)
    if ox2 > ox and oy2 > oy:
        out[max(0, oy) : oy2, max(0, ox) : ox2] = patch[: oy2 - max(0, oy), : ox2 - max(0, ox)]
    return out


def ranges_contain(rs, f):
    return any(a <= f <= b for a, b in rs)


def video_frames(path: Path, wanted: set[int]):
    cap = cv2.VideoCapture(str(path))
    i = 0
    while True:
        ok, img = cap.read()
        if not ok:
            break
        if i in wanted:
            yield i, img
        i += 1
    cap.release()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=ROOT / "datasets" / "local", type=Path)
    ap.add_argument("--accept", type=Path, help="目視確認過的自動標記範圍 JSON")
    ap.add_argument("--val", default="", help="當驗證集的影片名稱（逗號分隔）；預設每 5 支取 1 支")
    ap.add_argument("--stride-static", type=int, default=3, help="人工標記的靜止段每 N 格取 1 格（畫面幾乎相同）")
    ap.add_argument("--stride-auto", type=int, default=6, help="自動標記（accept.json）每 N 格取 1 格")
    args = ap.parse_args()

    accept = json.loads(args.accept.read_text(encoding="utf-8")) if args.accept else {}
    names = sorted(p.stem for p in DATA.glob("*.mp4"))
    val_names = set(x for x in args.val.split(",") if x)
    if not val_names:
        val_names = {n for i, n in enumerate(names) if i % 5 == 4}

    out: Path = args.out
    for sub in ("train", "val"):
        for kind in ("images", "labels"):
            d = out / sub / kind
            if d.exists():
                shutil.rmtree(d)
            d.mkdir(parents=True, exist_ok=True)

    total = {"train": 0, "val": 0}
    for name in names:
        pred_p = DATA / "eval" / f"{name}_pred.json"
        if not pred_p.exists():
            print(f"[skip] {name}: 沒有推論結果")
            continue
        pred = json.loads(pred_p.read_text(encoding="utf-8"))
        pf = {r["f"]: r for r in pred["frames"]}
        W, H = pred["W"], pred["H"]
        scale = MAX_SIDE / max(W, H)

        # 舊的推論結果沒有存軀幹長度：以手到桿頭距離的 75 百分位推估（App 中 L = 軀幹 × 1.9）
        if all(r.get("torso") is None for r in pf.values()):
            for r in pf.values():
                if r.get("r") is None and r.get("x") is not None and r.get("hx") is not None:
                    r["r"] = float(np.hypot(r["x"] - r["hx"], r["y"] - r["hy"]))
            rs = sorted(r["r"] for r in pf.values() if r.get("r"))
            if not rs:
                print(f"[skip] {name}: 推論結果缺少距離資訊")
                continue
            torso_est = rs[int(len(rs) * 0.75)] / 1.9
            for r in pf.values():
                r["torso"] = torso_est

        lab_p = DATA / "labels" / f"{name}_clubhead_labels.json"
        manual: dict[int, tuple[float, float]] = {}
        phases: dict[str, int] = {}
        if lab_p.exists():
            js = json.loads(lab_p.read_text(encoding="utf-8"))
            for r in js["labels"]:
                if r["status"] == "visible":
                    manual[r["frame"]] = (r["x"], r["y"])
                if r.get("phase"):
                    phases[r["phase"]] = r["frame"]
        auto_rs = accept.get(name, [])

        takeaway = phases.get("takeaway", 10**9)
        wanted: dict[int, tuple[float, float]] = {}
        for f, xy in manual.items():
            # 靜止段畫面幾乎相同，抽樣即可；揮桿段每格都要
            if f < takeaway and f % args.stride_static:
                continue
            wanted[f] = xy
        for f, r in pf.items():
            if f in wanted or not ranges_contain(auto_rs, f) or r["x"] is None:
                continue
            if f % args.stride_auto:
                continue
            wanted[f] = (r["x"], r["y"])
        if not wanted:
            print(f"[skip] {name}: 沒有可用標記")
            continue

        split = "val" if name in val_names else "train"
        n = 0
        for f, img in video_frames(DATA / f"{name}.mp4", set(wanted)):
            r = pf.get(f)
            if not r or r.get("torso") is None or r.get("hx") is None:
                continue
            small = cv2.resize(img, (int(round(W * scale)), int(round(H * scale))), interpolation=cv2.INTER_AREA)
            hx, hy, torso = r["hx"] * scale, r["hy"] * scale, r["torso"] * scale
            if not np.isfinite([hx, hy, torso]).all() or torso < 10:
                continue
            rx, ry, size = roi_of(hx, hy, torso, small.shape[1], small.shape[0])
            gx, gy = wanted[f][0] * scale, wanted[f][1] * scale
            cx, cy = (gx - rx) / size, (gy - ry) / size
            box = BOX_K * (torso * 1.9) / size
            if not (0 < cx < 1 and 0 < cy < 1):
                continue  # 桿頭落在裁切範圍外
            x0 = max(0.0, cx - box / 2)
            y0 = max(0.0, cy - box / 2)
            x1 = min(1.0, cx + box / 2)
            y1 = min(1.0, cy + box / 2)
            tile = crop(small, rx, ry, size)
            stem = f"{name}_{f:04d}"
            cv2.imwrite(str(out / split / "images" / f"{stem}.jpg"), tile, [cv2.IMWRITE_JPEG_QUALITY, 92])
            (out / split / "labels" / f"{stem}.txt").write_text(
                f"0 {(x0 + x1) / 2:.6f} {(y0 + y1) / 2:.6f} {x1 - x0:.6f} {y1 - y0:.6f}\n", encoding="utf-8"
            )
            n += 1
        total[split] += n
        print(f"[{split}] {name}: {n} 張（人工 {len(manual)}、自動 {sum(1 for f in wanted if f not in manual)}）")

    (out / "data.yaml").write_text(
        f"path: {out.as_posix()}\ntrain: train/images\nval: val/images\nnames:\n  0: club_head\n", encoding="utf-8"
    )
    print(f"train={total['train']} val={total['val']} → {out}")


if __name__ == "__main__":
    main()
