#!/usr/bin/env python3
"""Cache bounded Copernicus DEM elevation samples via Open-Meteo.

Standard library only. Samples are terrain reference data, not time-varying
landform observations or a future terrain prediction. No missing-value filling.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
import argparse
import hashlib
import json
import math
import threading
import time
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data/cloudshadow/neighborhoods"
ENDPOINT = "https://api.open-meteo.com/v1/elevation"
HALF_EXTENT = 3300
SIZE = 17
BATCH_SIZE = 100
EARTH = 6378137
REQUEST_SPACING_SECONDS = 11
REQUEST_LOCK = threading.Lock()
NEXT_REQUEST_AT = 0.0


def wait_for_request_slot():
    # The free service counts locations, not just HTTP requests. A 100-location
    # batch every 11 seconds avoids bursting beyond 600 locations per minute.
    global NEXT_REQUEST_AT
    with REQUEST_LOCK:
        delay = max(0.0, NEXT_REQUEST_AT - time.monotonic())
        NEXT_REQUEST_AT = max(time.monotonic(), NEXT_REQUEST_AT) + REQUEST_SPACING_SECONDS
    if delay:
        time.sleep(delay)


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def write_json(path, doc):
    pending = path.with_suffix(".pending")
    pending.write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    pending.replace(path)


def validate(doc):
    assert doc["schemaVersion"] == 1
    width, height = doc["width"], doc["height"]
    assert width == SIZE and height == SIZE
    assert len(doc["heights"]) == width * height
    assert doc["rowOrder"] == "south-to-north"
    assert doc["columnOrder"] == "west-to-east"
    assert doc["extentM"] == [-HALF_EXTENT, -HALF_EXTENT, HALF_EXTENT, HALF_EXTENT]
    assert all(x is None or isinstance(x, (float, int)) and math.isfinite(x) and -500 <= x <= 9000 for x in doc["heights"])
    count = sum(v is not None for v in doc["heights"])
    assert doc["validSamples"] == count
    assert (doc["status"] == "ready") == (count == width * height)


def acquire(site, refresh=False):
    ident = site["id"]
    dest = OUT / f"elevation-{ident}.json"
    existing = json.loads(dest.read_text(encoding="utf-8")) if dest.exists() else None
    if existing and existing.get("status") == "ready" and not refresh:
        validate(existing)
        print(json.dumps({"site": ident, "status": "cached", "validSamples": existing["validSamples"]}), flush=True)
        return existing
    doc = existing if existing and not refresh and existing.get("width") == SIZE else {
        "schemaVersion": 1, "siteId": ident, "center": {"lat": site["lat"], "lon": site["lon"]},
        "extentM": [-HALF_EXTENT, -HALF_EXTENT, HALF_EXTENT, HALF_EXTENT], "width": SIZE, "height": SIZE,
        "spacingM": 2 * HALF_EXTENT / (SIZE - 1), "rowOrder": "south-to-north", "columnOrder": "west-to-east",
        "units": "m", "heights": [None] * (SIZE * SIZE), "status": "unknown", "validSamples": 0,
        "source": {"name": "Copernicus DEM 2021 GLO-90 via Open-Meteo", "endpoint": ENDPOINT,
                   "url": "https://open-meteo.com/en/docs/elevation-api", "datasetUrl": "https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM",
                   "doi": "https://doi.org/10.5270/ESA-c5d3d65", "license": "CC-BY-4.0 (Open-Meteo API data)",
                   "licenseUrl": "https://open-meteo.com/en/licence", "nativeResolutionM": 90,
                   "verticalReference": "EGM2008 orthometric heights in meters (Copernicus DEM); no geoid-to-ellipsoid conversion applied",
                   "attribution": "Copernicus DEM / European Union and Open-Meteo.com",
                   "method": "17x17 point samples at 412.5m spacing; bilinear display interpolation, no finer evidence created",
                   "temporalMeaning": "Static reference DEM; not year-specific landform data", "batches": []}}
    errors = []
    sx = EARTH * math.cos(math.radians(site["lat"])) * math.pi / 180
    sy = EARTH * math.pi / 180
    coords = [(site["lat"] + (-HALF_EXTENT + row * doc["spacingM"]) / sy,
               site["lon"] + (-HALF_EXTENT + col * doc["spacingM"]) / sx)
              for row in range(SIZE) for col in range(SIZE)]
    for start in range(0, len(coords), BATCH_SIZE):
        end = min(start + BATCH_SIZE, len(coords))
        if all(x is not None for x in doc["heights"][start:end]):
            continue
        batch = coords[start:end]
        url = ENDPOINT + "?" + urllib.parse.urlencode({"latitude": ",".join(f"{p[0]:.7f}" for p in batch), "longitude": ",".join(f"{p[1]:.7f}" for p in batch)})
        try:
            wait_for_request_slot()
            request = urllib.request.Request(url, headers={"User-Agent": "FootprintAtlas/0.1 local-terrain-precompute (https://github.com/Moustafa-FD/NasaSpaceHacks2026GoofyGoobers)", "Accept": "application/json"})
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read(262145)
                if len(raw) > 262144:
                    raise ValueError("elevation response exceeds 256 KiB")
            result = json.loads(raw)
            values = result.get("elevation")
            if result.get("error") or not isinstance(values, list) or len(values) != len(batch):
                raise ValueError(result.get("reason", "invalid elevation result shape"))
            for i, value in enumerate(values):
                if isinstance(value, (int, float)) and math.isfinite(value) and -500 <= value <= 9000:
                    doc["heights"][start + i] = value
            doc["source"]["batches"].append({"startIndex": start, "count": len(batch), "downloadedAt": now(), "responseSha256": hashlib.sha256(raw).hexdigest()})
            print(json.dumps({"site": ident, "batchStart": start, "valid": sum(x is not None for x in doc["heights"])}), flush=True)
        except Exception as exc:
            errors.append({"startIndex": start, "count": end - start, "error": f"{type(exc).__name__}: {exc}", "at": now()})
            print(json.dumps({"site": ident, "batchStart": start, "status": "failed", "error": str(exc)}), flush=True)
            # Never immediately retry a rate-limited provider, including the next batch.
            if getattr(exc, "code", None) == 429:
                break
    count = sum(v is not None for v in doc["heights"])
    doc["validSamples"] = count
    doc["status"] = "ready" if count == SIZE * SIZE else "partial" if count else "unknown"
    doc["source"]["lastAttemptAt"] = now()
    if errors:
        doc["source"]["errors"] = errors
    else:
        doc["source"].pop("errors", None)
    valid = [v for v in doc["heights"] if v is not None]
    doc["rangeM"] = [min(valid), max(valid)] if valid else None
    validate(doc)
    if not (existing and existing.get("status") == "ready" and doc["status"] != "ready"):
        write_json(dest, doc)
    print(json.dumps({"site": ident, "status": doc["status"], "samples": count, "rangeM": doc["rangeM"]}), flush=True)
    return doc


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", action="append")
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--validate", action="store_true")
    args = parser.parse_args()
    sites = json.loads((ROOT / "data/cloudshadow/sites.json").read_text(encoding="utf-8"))["sites"]
    if args.site:
        if set(args.site) - {s["id"] for s in sites}:
            parser.error("unknown site ID")
        sites = [s for s in sites if s["id"] in args.site]
    OUT.mkdir(parents=True, exist_ok=True)
    if args.validate:
        for site in sites:
            doc = json.loads((OUT / f'elevation-{site["id"]}.json').read_text(encoding="utf-8"))
            validate(doc)
            print(json.dumps({"site": site["id"], "status": doc["status"], "samples": doc["validSamples"], "rangeM": doc["rangeM"]}))
        return
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(acquire, site, args.refresh) for site in sites]
        for future in as_completed(futures):
            future.result()


if __name__ == "__main__":
    main()
