#!/usr/bin/env python3
"""
Cloud Shadow - one cloud-free 30 m image per year per site, for the Unreal timeline slider.

NASA HLS (Harmonized Landsat 8/9 + Sentinel-2, via GIBS) starts 2013 (L30) / late 2015 (S30).
For each site and year, search outward from July 1 (+/- 75 days) for a GIBS tile over the site
with full coverage and almost no cloud/white pixels; stop at the first good one.

Writes data/cloudshadow/hls_timeline.json:
  { site: { "2013": {layer, date, cloud, templateUrl}, ... } }
Usage:  npm run data:timeline-imagery   (python scripts/hls_timeline.py [site ...] [--out=file.json])
"""
import json
import os
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import precompute as P  # reuses tile fetch/cache, catalog and geometry

LAYERS = ["HLS_L30_Nadir_BRDF_Adjusted_Reflectance", "HLS_S30_Nadir_BRDF_Adjusted_Reflectance"]
Z, TMS = 12, "GoogleMapsCompatible_Level12"
SPAN = 75


def score_tile(img):
    px = list(img.get_flattened_data()) if hasattr(img, "get_flattened_data") else list(img.getdata())
    n = len(px)
    cover = sum(1 for p in px if p[3] > 0) / n
    white = sum(1 for p in px if p[3] > 0 and p[0] > 190 and p[1] > 190 and p[2] > 190) / n
    return cover, white


def best_for_year(site, year, avail):
    gx, gy = P.world_px(site["lat"], site["lon"], Z)
    row, col = int(gy) // 256, int(gx) // 256
    t = date(year, 7, 1)
    offsets = sorted(range(-SPAN, SPAN + 1), key=abs)
    fallback = None
    for off in offsets:
        d = t + timedelta(days=off)
        if d >= date.today():
            continue
        for layer in LAYERS:
            if d not in avail[layer]:
                continue
            img = P.fetch_tile(layer, d, TMS, Z, row, col)
            if img is None:
                continue
            cover, white = score_tile(img)
            if cover < 0.98:
                continue
            if white < 0.01:
                return {"layer": layer, "date": d.isoformat(), "cloud": round(white, 3)}
            if white < 0.05 and (fallback is None or white < fallback["cloud"]):
                fallback = {"layer": layer, "date": d.isoformat(), "cloud": round(white, 3)}
    return fallback


def main():
    sites = json.load(open(os.path.join(P.DATA, "sites.json"), encoding="utf-8"))["sites"]
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if args:
        sites = [s for s in sites if s["id"] in args]
    P.CATALOG = P.load_catalog(set(LAYERS))
    avail = {L: set(P.expand(P.CATALOG[L]["intervals"])) for L in LAYERS}
    path = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--out=")), os.path.join(P.DATA, "hls_timeline.json"))
    out = json.load(open(path)) if os.path.exists(path) else {}
    for s in sites:
        out.setdefault(s["id"], {})
        for year in range(2013, date.today().year + 1):
            b = best_for_year(s, year, avail)
            if b:
                b["templateUrl"] = f"{P.GIBS}/{b['layer']}/default/{b['date']}/{TMS}/{{z}}/{{y}}/{{x}}.png"
                out[s["id"]][str(year)] = b
            print(f"  {s['id']:<10} {year}  {b['date'] + '  cloud ' + str(b['cloud']) if b else 'no clear image'}", flush=True)
            json.dump(out, open(path, "w"), indent=1)
    print("done")


if __name__ == "__main__":
    main()
