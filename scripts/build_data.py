#!/usr/bin/env python3
"""国土数値情報 鉄道時系列データ（N05-25）から北海道の駅・路線を抽出し、
ブラウザ表示用の JSON / GeoJSON を出力する。

標準ライブラリのみで動く。

使い方:
    python3 scripts/build_data.py --zip path/to/N05-25_GML.zip
    python3 scripts/build_data.py            # ZIPが無ければ公式URLから取得

出力:
    public/data/stations.json   物理的な駅単位にまとめた駅と元レコード
    public/data/lines.geojson   路線（区間）データ
    data/review.csv             統合規則で曖昧になったものの確認リスト
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import math
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE_URL = "https://nlftp.mlit.go.jp/ksj/gml/data/N05/N05-25/N05-25_GML.zip"
STATION_MEMBER = "N05-25_GML/UTF-8/N05-25_Station2.geojson"
LINE_MEMBER = "N05-25_GML/UTF-8/N05-25_RailroadSection2.geojson"

YEAR_MIN = 1950
YEAR_MAX = 2025  # データ基準時点（2025年末）
ONGOING = 9999
UNKNOWN = 999

# ---------------------------------------------------------------------------
# 北海道の範囲
# 大きな矩形では下北半島（大畑線）や津軽半島（津軽線・海峡線の本州側）が混入する。
# 津軽海峡の中央付近を南端とする多角形で判定する。
#   本州側で最も北にある駅: 大畑（下北交通大畑線） 41.402N 141.164E
#                          竜飛海底（海峡線）        41.257N 140.348E
#   北海道側で最も南にある駅: 渡島大沢（松前線）      41.423N 140.161E
# 経度 140.8°E より東は 41.6°N を境にし、大畑線を除外する。
# ---------------------------------------------------------------------------
HOKKAIDO_POLYGON = [
    (139.0, 41.36),
    (140.6, 41.36),
    (140.8, 41.60),
    (142.0, 41.60),
    (146.5, 42.30),
    (146.5, 46.00),
    (139.0, 46.00),
    (139.0, 41.36),
]

# 物理的な駅への統合規則（同じ関係IDは常に統合。距離による統合は期間が接するものに限る）
SAME_PLACE_M = 30        # 駅名を問わず同一地点とみなす距離
SAME_NAME_M = 300        # 同名・同じ事業者区分なら同じ駅とみなす距離
REVIEW_SPREAD_M = 500    # 統合後の点のばらつきがこれを超えたら確認対象
NEAR_SAME_NAME_M = 1000  # 別駅扱いだが同名で近いものを確認対象に


def point_in_polygon(x: float, y: float, poly=HOKKAIDO_POLYGON) -> bool:
    inside = False
    n = len(poly)
    for i in range(n - 1):
        x1, y1 = poly[i]
        x2, y2 = poly[i + 1]
        if (y1 > y) != (y2 > y):
            xin = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if x < xin:
                inside = not inside
    return inside


def dist_m(a, b) -> float:
    lat = math.radians((a[1] + b[1]) / 2)
    dx = (a[0] - b[0]) * 111320 * math.cos(lat)
    dy = (a[1] - b[1]) * 110540
    return math.hypot(dx, dy)


def to_int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def op_group(op: str) -> str:
    """同名・近接による統合で使う事業者の区分。国鉄とJR北海道は同じ扱い。"""
    if op in ("日本国有鉄道", "北海道旅客鉄道（旧国鉄）"):
        return "国鉄・JR"
    return op


def periods_touch(a, b) -> bool:
    """期間が重なるか、1年以内で接している（改称・移管の付け替え）か。

    路面電車の停留場と、何年も後に同じ場所へできた地下鉄駅のように、
    時期が離れたものは位置が近くても別駅として扱う。
    """
    ae = a["effE"] if a["effE"] is not None else a["effB"]
    be = b["effE"] if b["effE"] is not None else b["effB"]
    return a["effB"] <= be + 1 and b["effB"] <= ae + 1


class UnionFind:
    def __init__(self, n):
        self.p = list(range(n))

    def find(self, i):
        while self.p[i] != i:
            self.p[i] = self.p[self.p[i]]
            i = self.p[i]
        return i

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[max(ra, rb)] = min(ra, rb)


def load_zip(path: Path | None) -> zipfile.ZipFile:
    if path and path.exists():
        return zipfile.ZipFile(path)
    print(f"downloading {SOURCE_URL}")
    with urllib.request.urlopen(SOURCE_URL) as r:
        data = r.read()
    return zipfile.ZipFile(io.BytesIO(data))


def resolve_years(recs):
    """関係ID単位で、999（不明）を前後のレコードから補う。

    effB / effE は表示に使う年（両端含む）。effE=None は終了年不明。
    N05_005e は「変更・廃止年の前年」なので、その年までは存在したとみなす。
    """
    by_rel = defaultdict(list)
    for r in recs:
        by_rel[r["rel"]].append(r)
    for group in by_rel.values():
        group.sort(key=lambda r: (r["b"] if r["b"] not in (None, UNKNOWN) else r["open"] or 0, r["e"] or 0))
        for i, r in enumerate(group):
            notes = []
            b, e = r["b"], r["e"]
            if b in (None, UNKNOWN):
                prev = group[i - 1] if i > 0 else None
                if prev and prev["e"] not in (None, UNKNOWN, ONGOING):
                    b = prev["e"] + 1
                    notes.append("開始年不明：同じ関係IDの前レコード終了年の翌年とした")
                elif r["open"] not in (None, UNKNOWN) and r["open"] > YEAR_MIN:
                    b = r["open"]
                    notes.append("開始年不明：供用開始年を用いた")
                else:
                    b = YEAR_MIN
                    notes.append("開始年不明：1950年から表示")
            if e in (None, UNKNOWN):
                nxt = group[i + 1] if i + 1 < len(group) else None
                if nxt and nxt["b"] not in (None, UNKNOWN):
                    e = nxt["b"] - 1
                    notes.append("終了年不明：同じ関係IDの次レコード開始年の前年とした")
                else:
                    e = None
                    notes.append("終了年不明：期間不明として別表示")
            elif e == ONGOING:
                e = YEAR_MAX
            b = max(b, YEAR_MIN)
            r["effB"], r["effE"] = b, e
            r["ongoing"] = r["e"] == ONGOING
            r["yearNotes"] = notes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", type=Path, default=None)
    ap.add_argument("--fetched", default=dt.date.today().isoformat(), help="取得日")
    args = ap.parse_args()

    zf = load_zip(args.zip)
    st = json.loads(zf.read(STATION_MEMBER).decode("utf-8"))
    ln = json.loads(zf.read(LINE_MEMBER).decode("utf-8"))

    # ---- 駅レコード抽出 ----
    recs = []
    for idx, f in enumerate(st["features"]):
        g = f["geometry"]
        assert g["type"] == "Point", g["type"]
        x, y = g["coordinates"]
        if not point_in_polygon(x, y):
            continue
        p = f["properties"]
        recs.append({
            "src": idx,  # 元GeoJSON内のfeature番号
            "name": p["N05_011"],
            "line": p["N05_002"],
            "op": p["N05_003"],
            "kind": p["N05_001"],
            "open": to_int(p["N05_004"]),
            "b": to_int(p["N05_005b"]),
            "e": to_int(p["N05_005e"]),
            "rel": p["N05_006"],
            "chg": p["N05_007"],
            "chgNote": p["N05_008"],
            "posNote": p["N05_009"],
            "lon": round(x, 6),
            "lat": round(y, 6),
        })
    print(f"hokkaido station records: {len(recs)}")
    resolve_years(recs)

    # ---- 物理的な駅への統合 ----
    n = len(recs)
    uf = UnionFind(n)
    by_rel = defaultdict(list)
    for i, r in enumerate(recs):
        by_rel[r["rel"]].append(i)
    for idxs in by_rel.values():
        for j in idxs[1:]:
            uf.union(idxs[0], j)
    # 近接判定（格子で候補を絞る）
    cell = 0.005
    grid = defaultdict(list)
    for i, r in enumerate(recs):
        grid[(int(r["lon"] / cell), int(r["lat"] / cell))].append(i)
    for i, r in enumerate(recs):
        cx, cy = int(r["lon"] / cell), int(r["lat"] / cell)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in grid.get((cx + dx, cy + dy), []):
                    if j <= i:
                        continue
                    d = dist_m((r["lon"], r["lat"]), (recs[j]["lon"], recs[j]["lat"]))
                    if not periods_touch(r, recs[j]):
                        continue
                    if d <= SAME_PLACE_M or (d <= SAME_NAME_M and r["name"] == recs[j]["name"]
                                              and op_group(r["op"]) == op_group(recs[j]["op"])):
                        uf.union(i, j)

    clusters = defaultdict(list)
    for i in range(n):
        clusters[uf.find(i)].append(i)

    review = []
    stations = []
    for sid, (root, idxs) in enumerate(sorted(clusters.items(), key=lambda kv: kv[0])):
        rs = [recs[i] for i in idxs]
        rs.sort(key=lambda r: (r["effB"], r["line"]))
        spread = max(
            (dist_m((a["lon"], a["lat"]), (b["lon"], b["lat"])) for a in rs for b in rs),
            default=0,
        )
        flags = []
        if spread > REVIEW_SPREAD_M:
            flags.append(f"統合した点の最大距離 {spread:.0f}m")
        # 期間の空白
        known = sorted((r["effB"], r["effE"]) for r in rs if r["effE"] is not None)
        cover_end = None
        for b, e in known:
            if cover_end is not None and b > cover_end + 1:
                flags.append(f"{cover_end + 1}〜{b - 1}年にレコードの空白")
            cover_end = e if cover_end is None else max(cover_end, e)
        for f in flags:
            review.append({"sid": sid, "type": "統合", "detail": f,
                           "names": "／".join(dict.fromkeys(r["name"] for r in rs)),
                           "lines": "／".join(dict.fromkeys(r["line"] for r in rs))})
        stations.append({"sid": sid, "recs": rs, "flags": flags})

    # 同名で近いが別駅扱いになったもの
    for a in range(len(stations)):
        for b in range(a + 1, len(stations)):
            ra, rb = stations[a]["recs"][-1], stations[b]["recs"][-1]
            na = {r["name"] for r in stations[a]["recs"]}
            nb = {r["name"] for r in stations[b]["recs"]}
            common = na & nb
            if not common:
                continue
            d = dist_m((ra["lon"], ra["lat"]), (rb["lon"], rb["lat"]))
            if d <= NEAR_SAME_NAME_M:
                review.append({"sid": f"{a}/{b}", "type": "近接同名（別駅として扱った）",
                               "detail": f"{d:.0f}m",
                               "names": "／".join(sorted(common)),
                               "lines": "／".join(dict.fromkeys(r["line"] for r in stations[a]["recs"] + stations[b]["recs"]))})

    # ---- 出力（駅） ----
    out_recs = []
    out_st = []
    for s in stations:
        ids = []
        for r in s["recs"]:
            ids.append(len(out_recs))
            out_recs.append([
                r["src"], r["name"], r["line"], r["op"], r["kind"], r["open"],
                r["b"], r["e"], r["effB"], r["effE"], r["rel"], r["posNote"],
                "；".join(r["yearNotes"]) or None, r["lon"], r["lat"], s["sid"],
            ])
        out_st.append({"id": s["sid"], "r": ids, "f": s["flags"]})

    meta = {
        "source": "国土交通省 国土数値情報「鉄道時系列データ」N05 2025年度版（N05-25）",
        "sourceUrl": "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N05-2025.html",
        "license": "非商用（有償刊行物を原典に含む）",
        "fetched": args.fetched,
        "yearMin": YEAR_MIN,
        "yearMax": YEAR_MAX,
        "recordFields": ["src", "name", "line", "op", "kind", "open", "b", "e",
                         "effB", "effE", "rel", "posNote", "yearNote", "lon", "lat", "sid"],
        "rules": {
            "sameRelationId": True,
            "samePlaceM": SAME_PLACE_M,
            "sameNameM": SAME_NAME_M,
        },
        "counts": {"records": len(out_recs), "stations": len(out_st)},
    }
    outdir = ROOT / "public" / "data"
    outdir.mkdir(parents=True, exist_ok=True)
    (outdir / "stations.json").write_text(
        json.dumps({"meta": meta, "records": out_recs, "stations": out_st},
                   ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # ---- 出力（路線） ----
    line_recs = []
    for f in ln["features"]:
        coords = f["geometry"]["coordinates"]
        if not any(point_in_polygon(x, y) for x, y in coords):
            continue
        p = f["properties"]
        line_recs.append({
            "coords": [[round(x, 5), round(y, 5)] for x, y in coords],
            "name": p["N05_002"], "op": p["N05_003"], "open": to_int(p["N05_004"]),
            "b": to_int(p["N05_005b"]), "e": to_int(p["N05_005e"]), "rel": p["N05_006"],
        })
    resolve_years(line_recs)
    feats = []
    for r in line_recs:
        # 連続する重複点を除く
        cs = [c for k, c in enumerate(r["coords"]) if k == 0 or c != r["coords"][k - 1]]
        if len(cs) < 2:
            continue
        feats.append({
            "type": "Feature",
            "properties": {"n": r["name"], "o": r["op"], "b": r["effB"],
                           "e": r["effE"] if r["effE"] is not None else -1},
            "geometry": {"type": "LineString", "coordinates": cs},
        })
    (outdir / "lines.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": feats},
                   ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"line features: {len(feats)}")

    # ---- 確認リスト ----
    rdir = ROOT / "data"
    rdir.mkdir(exist_ok=True)
    with open(rdir / "review.csv", "w", encoding="utf-8", newline="") as fp:
        w = csv.DictWriter(fp, fieldnames=["sid", "type", "detail", "names", "lines"])
        w.writeheader()
        w.writerows(review)
    print(f"stations: {len(out_st)}  review items: {len(review)}")


if __name__ == "__main__":
    main()
