#!/usr/bin/env python3
"""Acquire one bounded local map patch for the same-origin streaming API.

Uses the existing OSM/Copernicus adapters, with their provenance and missing-data
semantics intact. The parent server serializes public-provider acquisition;
there are no recurring/background retries. Cached bundles are atomic, reusable,
and limited to twelve patches. Standard library only.
"""
from __future__ import annotations

import argparse
from contextlib import redirect_stdout
from datetime import datetime, timezone
import importlib.util
import json
import math
from pathlib import Path
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "tmp" / "streamed-neighborhoods"
MAX_PATCHES = 12


def load_adapter(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.OUT = CACHE
    return module


def patch_site(lat, lon):
    if not all(math.isfinite(value) for value in (lat, lon)) or abs(lat) > 75 or abs(lon) > 180:
        raise ValueError("latitude must be in [-75,75] and longitude in [-180,180]")
    north, east = math.floor(lat * 100 + 0.5), math.floor(lon * 100 + 0.5)
    ident = f'stream-{"s" if north < 0 else "n"}{abs(north)}-{"w" if east < 0 else "e"}{abs(east)}'
    return {"id": ident, "lat": north / 100, "lon": east / 100}


def atomic_json(path, document):
    pending = path.with_suffix(".pending")
    pending.write_text(json.dumps(document, separators=(",", ":"), ensure_ascii=False, allow_nan=False), encoding="utf-8")
    pending.replace(path)


def unavailable_urban(site, reason, status="unknown"):
    return {"schemaVersion": 1, "siteId": site["id"], "center": {"lat": site["lat"], "lon": site["lon"]}, "status": status,
            "source": {"name": "OpenStreetMap", "url": "https://www.openstreetmap.org/copyright", "license": "ODbL-1.0", "reason": reason},
            "surfaces": [], "airways": [], "airports": [], "roadTags": [], "crossings": [], "powerLines": [], "infrastructureNodes": []}


def acquire_optional_urban(adapter, site, remaining):
    if not adapter or remaining <= 5:
        return unavailable_urban(site, "urban-detail adapter unavailable or acquisition time budget exhausted")
    try:
        document = adapter.fetch_one(site, attempts=1)
        if document.get("status") == "ready":
            adapter.validate(document)
        return document
    except Exception as error:
        # Optional surface/parking/infrastructure errors never discard a ready
        # base map and DEM. No substitute paved surfaces or airports are made.
        return unavailable_urban(site, f"{type(error).__name__}: {error}", "failed")


def acquire_optional_recreation(adapter, site, remaining):
    missing = {"schemaVersion": 1, "siteId": site["id"], "center": {"lat": site["lat"], "lon": site["lon"]},
               "status": "unknown", "features": [], "source": {"name": "OpenStreetMap", "license": "ODbL-1.0"}}
    if not adapter or remaining <= 8:
        missing["source"]["reason"] = "recreation adapter unavailable or acquisition budget exhausted"
        return missing
    try:
        document = adapter.fetch_one(site, attempts=1)
        if document.get("status") == "ready":
            adapter.validate(document)
        return document
    except Exception as error:
        missing["status"] = "failed"
        missing["source"]["reason"] = f"{type(error).__name__}: {error}"
        return missing


def validate_bundle(document, site, base, terrain, urban):
    snapshot = document["snapshot"]
    assert document["status"] == "ready" and snapshot["status"] == "ready"
    assert snapshot["center"] == {"lat": site["lat"], "lon": site["lon"]}
    base.validate(snapshot)
    elevation = document.get("elevation")
    assert elevation is not None, "missing terrain must be an explicit unknown grid"
    assert elevation["center"] == snapshot["center"]
    terrain.validate(elevation)
    surfaces = document.get("urban")
    if urban and surfaces and surfaces.get("status") == "ready":
        assert surfaces["center"] == snapshot["center"]
        urban.validate(surfaces)


def prune_cache(current):
    bundles = sorted(CACHE.glob("bundle-stream-*.json"), key=lambda path: path.stat().st_mtime, reverse=True)
    for bundle in bundles[MAX_PATCHES:]:
        ident = bundle.name[len("bundle-"):-len(".json")]
        if ident == current:
            continue
        # Identifiers only come from the numeric quantizer; never prune arbitrary paths.
        if not all(character.isalnum() or character == "-" for character in ident):
            continue
        for prefix in ("bundle-", "", "elevation-", "urban-", "recreation-"):
            path = CACHE / f"{prefix}{ident}.json"
            if path.is_file():
                path.unlink()


def acquire(lat, lon, *, cache_only=False):
    site = patch_site(lat, lon)
    CACHE.mkdir(parents=True, exist_ok=True)
    base = load_adapter("stream_osm_adapter", "fetch-neighborhoods.py")
    terrain = load_adapter("stream_dem_adapter", "fetch-terrain.py")
    urban_path = ROOT / "scripts" / "fetch-urban-detail.py"
    try:
        urban = load_adapter("stream_urban_adapter", urban_path.name) if urban_path.exists() else None
    except Exception as error:
        print(f"Optional urban adapter unavailable: {type(error).__name__}: {error}", file=sys.stderr)
        urban = None
    try:
        recreation = load_adapter("stream_recreation_adapter", "fetch-recreation.py")
    except Exception as error:
        print(f"Optional recreation adapter unavailable: {type(error).__name__}: {error}", file=sys.stderr)
        recreation = None
    bundle_path = CACHE / f'bundle-{site["id"]}.json'
    if bundle_path.exists():
        try:
            cached = json.loads(bundle_path.read_text(encoding="utf-8"))
            validate_bundle(cached, site, base, terrain, urban)
            return bundle_path, cached
        except (ValueError, KeyError, AssertionError):
            pass
    if cache_only:
        raise ValueError("no valid cached patch for these coordinates")

    deadline = time.monotonic() + 170
    original_urlopen = urllib.request.urlopen

    def bounded_urlopen(request, *args, **kwargs):
        remaining = deadline - time.monotonic()
        if remaining < 2:
            raise TimeoutError("streamed patch acquisition time budget exhausted")
        kwargs["timeout"] = min(float(kwargs.get("timeout", 30)), remaining)
        return original_urlopen(request, *args, **kwargs)

    # Preserve Open-Meteo's 11-second, 100-location pacing across child jobs too.
    # The production server permits one provider job at a time, so no two writers.
    def wait_for_elevation_slot():
        slot_path = CACHE / "elevation-next-request.json"
        try:
            next_at = float(json.loads(slot_path.read_text(encoding="utf-8"))["nextAt"])
        except (OSError, ValueError, TypeError, KeyError):
            next_at = 0
        delay = max(0, min(11, next_at - time.time()))
        if time.monotonic() + delay + 2 > deadline:
            raise TimeoutError("terrain request deferred beyond acquisition time budget")
        atomic_json(slot_path, {"nextAt": max(time.time(), next_at) + 11})
        if delay:
            time.sleep(delay)

    urllib.request.urlopen = bounded_urlopen
    terrain.wait_for_request_slot = wait_for_elevation_slot
    try:
        with redirect_stdout(sys.stderr):
            # One bounded attempt per provider query. A user retry is cooled down
            # by the server, and ready component files are reused on that retry.
            _, snapshot = base.fetch_one(site, attempts=1)
            if snapshot.get("status") != "ready":
                raise RuntimeError("OpenStreetMap acquisition failed; existing area remains available")
            elevation = terrain.acquire(site)
            surfaces = acquire_optional_urban(urban, site, deadline - time.monotonic())
            leisure = acquire_optional_recreation(recreation, site, deadline - time.monotonic())
        document = {"status": "ready", "snapshot": snapshot, "elevation": elevation, "urban": surfaces, "recreation": leisure,
                    "streaming": {"acquiredAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                                  "quantizationDegrees": 0.01, "radiusM": 3300,
                                  "coverage": "Current contributed map data for this bounded patch; not historical reconstruction."}}
        validate_bundle(document, site, base, terrain, urban)
        atomic_json(bundle_path, document)
        prune_cache(site["id"])
        return bundle_path, document
    finally:
        urllib.request.urlopen = original_urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lat", type=float, required=True)
    parser.add_argument("--lon", type=float, required=True)
    parser.add_argument("--cache-only", action="store_true", help="Validate a cached bundle without network acquisition")
    args = parser.parse_args()
    try:
        path, document = acquire(args.lat, args.lon, cache_only=args.cache_only)
        print(json.dumps({"status": "ready", "siteId": document["snapshot"]["siteId"], "bundle": str(path),
                          "elevationStatus": document["elevation"]["status"], "urbanStatus": document["urban"]["status"]}))
    except Exception as error:
        print(json.dumps({"status": "failed", "error": f"{type(error).__name__}: {error}"}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
