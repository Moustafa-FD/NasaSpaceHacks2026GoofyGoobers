"""Bounded, resumable access to real NASA POWER global monthly MERRA-2 grids.

One stdin JSON request; stdout JSON-lines progress plus one final result.
The cache contains original compressed Zarr v2 chunks, not fabricated grids.
"""
from __future__ import annotations

import hashlib
import itertools
import json
import math
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePath, PureWindowsPath
from typing import Any

import numpy as np
from numcodecs import get_codec

SOURCE_URL = "https://nasa-power.s3.us-west-2.amazonaws.com/merra2/temporal/power_merra2_monthly_temporal_utc.zarr"
ALLOWED_VARIABLES = ("T2M", "PRECTOTCORR", "RH2M", "WS2M")
DEFAULT_BUDGET = 768 * 1024 * 1024
MAX_ASSET_BYTES = 8 * 1024 * 1024
OUT_LOCK = threading.Lock()


class DataError(ValueError):
    def __init__(self, message: str, code: str = "DATA_ERROR"):
        super().__init__(message)
        self.code = code


def emit(message: dict[str, Any]) -> None:
    with OUT_LOCK:
        sys.stdout.write(json.dumps(message, allow_nan=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def containment_path(path: PurePath) -> PurePath:
    r"""Compare equivalent Windows drive/UNC anchors with or without \\?\.

    Windows realpath may retain its extended-length prefix when another thread
    creates a previously absent parent during resolution. Keep using the fully
    resolved path for IO, but remove this spelling difference for containment.
    Other device namespaces remain unchanged and must match exactly.
    """
    if isinstance(path, PureWindowsPath):
        text = str(path)
        if text[:8].lower() == "\\\\?\\unc\\":
            return PureWindowsPath("\\\\" + text[8:])
        if re.match(r"^\\\\\?\\[a-zA-Z]:\\", text):
            return PureWindowsPath(text[4:])
    return path


def fetch_bytes(url: str, limit: int = MAX_ASSET_BYTES, etag: str | None = None) -> tuple[bytes | None, dict[str, Any]]:
    """No auth headers are used; only the fixed public NASA S3 origin is queried."""
    if not url.startswith(SOURCE_URL + "/"):
        raise DataError("Upstream URL is outside the fixed NASA source", "INVALID_SOURCE")
    for attempt in range(3):
        try:
            headers = {"User-Agent": "GoofyGoobers-SpaceApps2026/0.2"}
            if etag: headers["If-None-Match"] = etag
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=25) as response:
                size = response.headers.get("Content-Length")
                if size and int(size) > limit:
                    raise DataError("NASA asset exceeds the per-file download budget", "ASSET_TOO_LARGE")
                data = response.read(limit + 1)
                if len(data) > limit:
                    raise DataError("NASA asset exceeds the per-file download budget", "ASSET_TOO_LARGE")
                return data, {"etag": response.headers.get("ETag"), "lastModified": response.headers.get("Last-Modified")}
        except urllib.error.HTTPError as error:
            if error.code == 304: return None, {}
            if error.code == 404:
                raise DataError("NASA chunk is absent; missing chunks are not replaced with zeros", "UPSTREAM_MISSING") from error
            if error.code != 429 and error.code < 500:
                raise DataError(f"NASA returned HTTP {error.code}", "UPSTREAM_HTTP") from error
            if attempt == 2:
                raise DataError(f"NASA returned HTTP {error.code} after retries", "UPSTREAM_HTTP") from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            if attempt == 2:
                raise DataError(f"NASA request failed: {error}", "UPSTREAM_UNAVAILABLE") from error
        time.sleep(attempt + 1)
    raise DataError("NASA request failed", "UPSTREAM_UNAVAILABLE")


def decode_chunk(payload: bytes, spec: dict[str, Any]) -> np.ndarray:
    if spec.get("zarr_format") != 2 or spec.get("order", "C") not in ("C", "F"):
        raise DataError("Unsupported Zarr array encoding", "UNSUPPORTED_ENCODING")
    raw: Any = payload
    if spec.get("compressor"):
        raw = get_codec(spec["compressor"]).decode(raw)
    for filter_spec in reversed(spec.get("filters") or []):
        raw = get_codec(filter_spec).decode(raw)
    dtype = np.dtype(spec["dtype"])
    values = np.asarray(raw, dtype=dtype) if isinstance(raw, np.ndarray) else np.frombuffer(raw, dtype=dtype)
    expected = math.prod(spec["chunks"])
    if values.size != expected:
        raise DataError(f"Chunk decoded {values.size} values instead of {expected}", "INVALID_CHUNK")
    return values.reshape(tuple(spec["chunks"]), order=spec.get("order", "C"))


def valid_mask(values: np.ndarray, spec: dict[str, Any], attrs: dict[str, Any]) -> np.ndarray:
    valid = np.isfinite(values)
    fill = spec.get("fill_value")
    if isinstance(fill, (int, float)) and math.isfinite(fill):
        valid &= values != fill
    for name in ("_FillValue", "missing_value"):
        missing = attrs.get(name)
        if isinstance(missing, (int, float)) and math.isfinite(missing):
            valid &= values != missing
    if isinstance(attrs.get("valid_min"), (int, float)):
        valid &= values >= attrs["valid_min"]
    if isinstance(attrs.get("valid_max"), (int, float)):
        valid &= values <= attrs["valid_max"]
    return valid


def chunk_keys(name: str, spec: dict[str, Any]) -> list[tuple[str, tuple[int, ...]]]:
    shape, chunks = spec["shape"], spec["chunks"]
    if len(shape) != len(chunks) or any(not isinstance(n, int) or n <= 0 for n in shape + chunks):
        raise DataError("Invalid Zarr dimensions", "UNSUPPORTED_ENCODING")
    separator = spec.get("dimension_separator", ".")
    if separator != ".":
        raise DataError("Only dot-separated Zarr v2 chunk keys are supported", "UNSUPPORTED_ENCODING")
    return [(f"{name}/" + ".".join(map(str, index)), index) for index in itertools.product(*(range(math.ceil(a / b)) for a, b in zip(shape, chunks))) ]


class Cache:
    def __init__(self, directory: str, max_bytes: int = DEFAULT_BUDGET):
        path = Path(directory)
        if not path.is_absolute():
            raise DataError("cacheDir must be an absolute path supplied by the application", "INVALID_REQUEST")
        if isinstance(max_bytes, bool) or not isinstance(max_bytes, int) or max_bytes < 1024 * 1024 or max_bytes > 1024 * 1024 * 1024:
            raise DataError("maxBytes must be between 1 MiB and 1 GiB", "INVALID_REQUEST")
        self.root = path.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.max_bytes = max_bytes
        self.lock = threading.RLock()
        self.used_bytes = sum(item.stat().st_size for item in self.root.rglob("*") if item.is_file())
        self.downloaded_bytes = 0
        manifest_file = self.root / "inventory.json"
        self.manifest = json.loads(manifest_file.read_text("utf-8")) if manifest_file.exists() else {
            "schemaVersion": "1.0", "sourceUrl": SOURCE_URL, "snapshotCreatedAt": datetime.now(timezone.utc).isoformat(), "files": {}, "variables": {},
        }
        if self.manifest.get("sourceUrl") != SOURCE_URL:
            raise DataError("Cache belongs to a different data source", "CACHE_CONFLICT")

    def target(self, key: str) -> Path:
        if key != ".zmetadata" and not re.fullmatch(r"(?:lat|lon|time|T2M|PRECTOTCORR|RH2M|WS2M)/\d+(?:\.\d+)*", key):
            raise DataError("Invalid cache key", "INVALID_REQUEST")
        target = (self.root / key).resolve()
        if not containment_path(target).is_relative_to(containment_path(self.root)):
            raise DataError("Cache path escapes cacheDir", "INVALID_REQUEST")
        return target

    def _atomic(self, target: Path, data: bytes) -> None:
        old_size = target.stat().st_size if target.exists() else 0
        if self.used_bytes + len(data) > self.max_bytes:
            raise DataError("Global cache budget reached; verified chunks remain resumable", "BUDGET_EXCEEDED")
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(target.name + "." + uuid.uuid4().hex + ".part")
        try:
            temporary.write_bytes(data)
            os.replace(temporary, target)
        finally:
            if temporary.exists(): temporary.unlink()
        self.used_bytes += len(data) - old_size

    def save(self) -> None:
        with self.lock:
            encoded = json.dumps(self.manifest, allow_nan=False, separators=(",", ":")).encode("utf-8")
            self._atomic(self.root / "inventory.json", encoded)

    def cached(self, key: str) -> bytes | None:
        record = self.manifest["files"].get(key)
        target = self.target(key)
        if not record or not target.is_file(): return None
        data = target.read_bytes()
        if len(data) != record.get("bytes") or digest(data) != record.get("sha256"): return None
        return data

    def ensure(self, key: str, spec: dict[str, Any] | None = None, *, refresh: bool = False) -> bytes:
        existing = self.cached(key)
        if existing is not None and not refresh: return existing
        etag = self.manifest["files"].get(key, {}).get("etag") if existing is not None else None
        data, headers = fetch_bytes(SOURCE_URL + "/" + key, 2 * 1024 * 1024 if key == ".zmetadata" else MAX_ASSET_BYTES, etag)
        if data is None:
            if existing is None: raise DataError("NASA returned 304 without a verified cached asset", "INVALID_CACHE")
            return existing
        if spec is not None: decode_chunk(data, spec)
        else:
            parsed = json.loads(data)
            if parsed.get("zarr_consolidated_format") != 1 or not isinstance(parsed.get("metadata"), dict):
                raise DataError("Invalid consolidated NASA Zarr metadata", "INVALID_METADATA")
        with self.lock:
            old_record = self.manifest["files"].get(key)
            record = {"sha256": digest(data), "bytes": len(data), "retrievedAt": datetime.now(timezone.utc).isoformat(), **headers}
            self.manifest["files"][key] = record
            try:
                next_inventory_size = len(json.dumps(self.manifest, allow_nan=False, separators=(",", ":")).encode("utf-8"))
                target = self.target(key)
                old_file_size = target.stat().st_size if target.exists() else 0
                if self.used_bytes - old_file_size + len(data) + next_inventory_size > self.max_bytes:
                    raise DataError("Cache budget cannot fit asset plus atomic inventory update; verified chunks remain resumable", "BUDGET_EXCEEDED")
                self._atomic(target, data)
            except BaseException:
                # _atomic preserves the original asset on write/replace failure;
                # its original checksum must remain usable for resume as well.
                if old_record is None: self.manifest["files"].pop(key, None)
                else: self.manifest["files"][key] = old_record
                raise
            self.downloaded_bytes += len(data)
            self.save()
        return data

    def require(self, key: str, spec: dict[str, Any]) -> np.ndarray:
        data = self.cached(key)
        if data is None:
            raise DataError(f"Required chunk {key} is not verified in the local cache; run sync first", "MISSING_CACHE")
        return decode_chunk(data, spec)

    def metadata(self, download: bool) -> dict[str, Any]:
        data = self.ensure(".zmetadata", refresh=True) if download else self.cached(".zmetadata")
        if data is None: raise DataError("NASA metadata is not cached; run sync first", "MISSING_CACHE")
        return json.loads(data)["metadata"]


def coordinates(cache: Cache, metadata: dict[str, Any], download: bool) -> tuple[np.ndarray, np.ndarray, list[str]]:
    arrays: dict[str, np.ndarray] = {}
    for name in ("lat", "lon", "time"):
        spec = metadata[f"{name}/.zarray"]
        result = np.empty(tuple(spec["shape"]), dtype=np.dtype(spec["dtype"]))
        for key, index in chunk_keys(name, spec):
            values = decode_chunk(cache.ensure(key, spec, refresh=True), spec) if download else cache.require(key, spec)
            start = index[0] * spec["chunks"][0]
            count = min(spec["chunks"][0], spec["shape"][0] - start)
            result[start:start + count] = values[:count]
        arrays[name] = result
    time_attrs = metadata["time/.zattrs"]
    if time_attrs.get("calendar", "proleptic_gregorian") not in ("standard", "gregorian", "proleptic_gregorian"):
        raise DataError("Unsupported source calendar", "UNSUPPORTED_ENCODING")
    match = re.fullmatch(r"days since (\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?", time_attrs.get("units", ""))
    if not match: raise DataError("Unsupported source time coordinate", "UNSUPPORTED_ENCODING")
    epoch = datetime.fromisoformat(match[1] + "T" + (match[2] or "00:00:00"))
    dates = [(epoch + timedelta(days=float(value))).strftime("%Y-%m") for value in arrays["time"]]
    if len(set(dates)) != len(dates): raise DataError("Source is not a unique monthly series", "INVALID_METADATA")
    return arrays["lat"].astype(float), arrays["lon"].astype(float), dates


def variables(request: dict[str, Any], *, grid: bool = False) -> list[str]:
    selected = request.get("variables", ["T2M"] if grid else list(ALLOWED_VARIABLES))
    if not isinstance(selected, list) or not selected or any(not isinstance(item, str) or item not in ALLOWED_VARIABLES for item in selected) or len(set(selected)) != len(selected):
        raise DataError("variables must be unique supported NASA parameter names", "INVALID_REQUEST")
    if grid and len(selected) != 1: raise DataError("A grid request requires exactly one variable", "INVALID_REQUEST")
    return selected


def cropped(values: np.ndarray, spec: dict[str, Any], index: tuple[int, ...]) -> np.ndarray:
    return values[tuple(slice(0, min(chunk, size - position * chunk)) for size, chunk, position in zip(spec["shape"], spec["chunks"], index))]


def current_month() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m")


def base_result(cache: Cache, metadata: dict[str, Any]) -> dict[str, Any]:
    return {"sourceId": "nasa-power-merra2-monthly-utc", "sourceUrl": SOURCE_URL,
            "documentationUrl": "https://power.larc.nasa.gov/docs/services/aws/", "evidence": "model-derived",
            "timeStandard": "UTC", "spatialResolution": {"latitudeDegrees": 0.5, "longitudeDegrees": 0.625},
            "version": metadata.get(".zattrs", {}).get("version"), "snapshotCreatedAt": cache.manifest["snapshotCreatedAt"],
            "cacheBytes": cache.used_bytes, "downloadedBytes": cache.downloaded_bytes,
            "warnings": ["MERRA-2 assimilation-model-derived data, not direct facility measurements or a forecast.",
                         "The Zarr time axis reserves future months; only past/current months with finite source data are reported as available.",
                         "Source chunks contain the full time axis for a spatial tile, so downloading recent months first cannot avoid fetching their historical chunk bytes.",
                         "Native grid spacing does not support building-scale environmental attribution."]}


def sync(request: dict[str, Any], cache: Cache) -> dict[str, Any]:
    metadata = cache.metadata(True)
    lats, lons, dates = coordinates(cache, metadata, True)
    selected = variables(request)
    cache.manifest["complete"] = False
    cache.manifest["completeForVariables"] = selected
    cache.manifest["lastSyncStartedAt"] = datetime.now(timezone.utc).isoformat()
    cache.save()
    latest = current_month()
    cutoff = np.array([date <= latest for date in dates])
    variable_results = []
    total_chunks = sum(len(chunk_keys(name, metadata[f"{name}/.zarray"])) for name in selected)
    completed = 0
    for name in selected:
        spec, attrs = metadata[f"{name}/.zarray"], metadata[f"{name}/.zattrs"]
        if attrs.get("_ARRAY_DIMENSIONS") != ["time", "lat", "lon"] or spec["shape"] != [len(dates), len(lats), len(lons)]:
            raise DataError(f"Unsupported array layout for {name}", "UNSUPPORTED_ENCODING")
        entries = chunk_keys(name, spec)
        counts = np.zeros(len(dates), dtype=np.int64)
        cache.manifest["variables"][name] = {"status": "partial", "expectedChunks": len(entries), "completeChunks": 0, "units": attrs.get("units")}
        cache.save()

        def acquire(entry: tuple[str, tuple[int, ...]]) -> tuple[tuple[int, ...], np.ndarray]:
            key, index = entry
            values = cropped(decode_chunk(cache.ensure(key, spec, refresh=True), spec), spec, index)
            return index, valid_mask(values, spec, attrs).sum(axis=(1, 2), dtype=np.int64)

        # Four bounded downloads; failures cancel pending work while completed files remain resumable.
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(acquire, entry) for entry in entries]
            try:
                for future in as_completed(futures):
                    index, valid_counts = future.result()
                    start = index[0] * spec["chunks"][0]
                    counts[start:start + len(valid_counts)] += valid_counts
                    completed += 1
                    cache.manifest["variables"][name]["completeChunks"] += 1
                    emit({"type": "progress", "stage": f"sync:{name}", "completedChunks": completed, "totalChunks": total_chunks, "downloadedBytes": cache.downloaded_bytes})
            except Exception:
                for future in futures: future.cancel()
                cache.save()
                raise
        counts[~cutoff] = 0
        valid_dates = [date for date, count in zip(dates, counts) if count > 0]
        entry = {"variable": name, "status": "complete", "globalGrid": True, "expectedChunks": len(entries), "completeChunks": len(entries),
                 "firstValidDate": valid_dates[0] if valid_dates else None, "lastValidDate": valid_dates[-1] if valid_dates else None,
                 "validMonthCount": len(valid_dates), "gridCellCount": len(lats) * len(lons), "units": attrs.get("units"),
                 "monthlyCoverage": [{"date": date, "validCellCount": int(count), "coverageFraction": float(count / (len(lats) * len(lons)))} for date, count in zip(dates, counts) if count > 0],
                 "temporalAggregation": attrs.get("cell_methods"), "sourceDefinition": attrs.get("definition")}
        cache.manifest["variables"][name] = entry
        cache.save()
        variable_results.append(entry)
    revision_text = "\n".join(key + ":" + entry["sha256"] for key, entry in sorted(cache.manifest["files"].items()))
    cache.manifest["sourceRevision"] = digest(revision_text.encode("utf-8"))
    cache.manifest["complete"] = True
    cache.manifest["lastSuccessfulSyncAt"] = datetime.now(timezone.utc).isoformat()
    cache.save()
    return {**base_result(cache, metadata), "status": "complete", "complete": True, "sourceRevision": cache.manifest["sourceRevision"], "variables": variable_results,
            "coverage": "all source spatial chunks for the listed variables, with the complete encoded time axis"}


def month_bound(value: Any, fallback: str) -> str:
    if value is None: return fallback
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", value):
        raise DataError("Dates must use YYYY-MM", "INVALID_REQUEST")
    return value


def query_data(request: dict[str, Any], cache: Cache, *, grid: bool = False) -> dict[str, Any]:
    metadata = cache.metadata(False)
    lats, lons, dates = coordinates(cache, metadata, False)
    selected = variables(request, grid=grid)
    start = month_bound(request.get("start"), dates[0]); end = month_bound(request.get("end"), current_month())
    if start > end: raise DataError("Date range must be ordered", "INVALID_REQUEST")
    indices = np.array([i for i, date in enumerate(dates) if start <= date <= min(end, current_month())], dtype=int)
    if not len(indices): raise DataError("No source months overlap the requested dates", "NO_DATA")
    lat_indices = np.arange(len(lats)); lon_indices = np.arange(len(lons))
    selection: dict[str, Any] = {"type": "global"}
    if request.get("point") is not None and request.get("bbox") is not None: raise DataError("Choose point or bbox", "INVALID_REQUEST")
    if request.get("point") is not None:
        point = request["point"]
        if not isinstance(point, dict) or not all(isinstance(point.get(key), (int, float)) and not isinstance(point[key], bool) and math.isfinite(point[key]) for key in ("latitude", "longitude")) or not -90 <= point["latitude"] <= 90 or not -180 <= point["longitude"] <= 180:
            raise DataError("Invalid WGS84 point", "INVALID_REQUEST")
        lat_indices = np.array([int(np.argmin(np.abs(lats - point["latitude"])))])
        distances = np.abs(lons - point["longitude"])
        lon_indices = np.array([int(np.argmin(np.minimum(distances, 360 - distances)))])
        selection = {"type": "point", "requested": point, "sourcePoint": {"latitude": float(lats[lat_indices[0]]), "longitude": float(lons[lon_indices[0]])}}
    elif request.get("bbox") is not None:
        bbox = request["bbox"]
        if not isinstance(bbox, list) or len(bbox) != 4 or not all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) for value in bbox): raise DataError("Invalid bbox", "INVALID_REQUEST")
        west, south, east, north = bbox
        if not -180 <= west < east <= 180 or not -90 <= south < north <= 90: raise DataError("Invalid ordered WGS84 bbox; dateline crossing unsupported", "INVALID_REQUEST")
        lat_indices = np.flatnonzero((lats >= south) & (lats <= north)); lon_indices = np.flatnonzero((lons >= west) & (lons <= east))
        selection = {"type": "bbox", "bbox": bbox}
    if not len(lat_indices) or not len(lon_indices): raise DataError("No native grid-cell centers inside selection", "NO_DATA")
    if grid:
        default_date = cache.manifest["variables"].get(selected[0], {}).get("lastValidDate") or dates[indices[-1]]
        date = month_bound(request.get("date"), default_date)
        if date > current_month() or date not in dates: raise DataError("Requested grid month is unavailable", "NO_DATA")
        indices = np.array([dates.index(date)])
    # Spherical latitude-band areas, truncated at poles. Longitude cell widths are uniform.
    edges = np.concatenate(([max(-90, lats[0] - (lats[1] - lats[0]) / 2)], (lats[:-1] + lats[1:]) / 2, [min(90, lats[-1] + (lats[-1] - lats[-2]) / 2)]))
    weights = np.abs(np.diff(np.sin(np.deg2rad(edges))))
    metrics = []
    frame: dict[str, Any] | None = None
    for name in selected:
        spec, attrs = metadata[f"{name}/.zarray"], metadata[f"{name}/.zattrs"]
        sums = np.zeros(len(indices)); weight_sums = np.zeros(len(indices)); counts = np.zeros(len(indices), dtype=np.int64)
        if grid: full_grid = np.full((len(lat_indices), len(lon_indices)), np.nan)
        required: list[tuple[str, tuple[int, ...], np.ndarray, np.ndarray, np.ndarray]] = []
        for key, chunk_index in chunk_keys(name, spec):
            t0, y0, x0 = [position * size for position, size in zip(chunk_index, spec["chunks"])]
            ti = np.flatnonzero((indices >= t0) & (indices < t0 + spec["chunks"][0]))
            yi = np.flatnonzero((lat_indices >= y0) & (lat_indices < y0 + spec["chunks"][1]))
            xi = np.flatnonzero((lon_indices >= x0) & (lon_indices < x0 + spec["chunks"][2]))
            if len(ti) and len(yi) and len(xi): required.append((key, chunk_index, ti, yi, xi))
        # Verify all requested chunks first; never average only whichever tiles happened to download.
        for key, _, _, _, _ in required:
            if cache.cached(key) is None: raise DataError(f"Missing or unverified chunk {key}; complete sync before this query", "MISSING_CACHE")
        for key, chunk_index, ti, yi, xi in required:
            chunk = cache.require(key, spec)
            t0, y0, x0 = [position * size for position, size in zip(chunk_index, spec["chunks"])]
            values = chunk[np.ix_(indices[ti] - t0, lat_indices[yi] - y0, lon_indices[xi] - x0)]
            valid = valid_mask(values, spec, attrs)
            area = weights[lat_indices[yi]][None, :, None]
            sums[ti] += np.where(valid, values * area, 0).sum(axis=(1, 2))
            weight_sums[ti] += np.where(valid, area, 0).sum(axis=(1, 2))
            counts[ti] += valid.sum(axis=(1, 2))
            if grid: full_grid[np.ix_(yi, xi)] = np.where(valid[0], values[0], np.nan)
        series = [{"date": dates[index], "value": float(sums[i] / weight_sums[i]) if weight_sums[i] > 0 else None,
                   "validCellCount": int(counts[i]), "totalCellCount": len(lat_indices) * len(lon_indices),
                   "coverageFraction": float(counts[i] / (len(lat_indices) * len(lon_indices)))} for i, index in enumerate(indices)]
        metrics.append({"variable": name, "label": attrs.get("long_name", name), "units": attrs.get("units"), "definition": attrs.get("definition"),
                        "aggregation": "nearest_native_grid_cell" if selection["type"] == "point" else "spherical_latitude_band_weighted_valid_cell_mean",
                        "temporalAggregation": attrs.get("cell_methods"), "series": series,
                        "uncertainty": {"status": "not_quantified", "reason": "No observational or model-error uncertainty was supplied or estimated by this ingestion service."}})
        if grid:
            flat = [round(float(value), 6) if np.isfinite(value) else None for value in full_grid.ravel()]
            frame = {"variable": name, "date": dates[indices[0]], "units": attrs.get("units"), "latitudes": lats[lat_indices].tolist(), "longitudes": lons[lon_indices].tolist(),
                     "shape": [len(lat_indices), len(lon_indices)], "order": "latitude-major rows, longitude-minor columns", "values": flat}
    result = {**base_result(cache, metadata), "selection": selection, "metrics": metrics,
              "globalCacheComplete": all(cache.manifest["variables"].get(name, {}).get("status") == "complete" for name in selected)}
    if frame is not None: result["grid"] = frame
    return result


def main() -> int:
    cache: Cache | None = None
    try:
        raw = sys.stdin.buffer.read(65_537)
        if len(raw) > 65_536: raise DataError("Worker request exceeds 64 KiB", "INVALID_REQUEST")
        request = json.loads(raw.decode("utf-8"))
        if not isinstance(request, dict): raise DataError("Request must be an object", "INVALID_REQUEST")
        action = request.get("action")
        if action not in ("sync", "series", "grid"): raise DataError("Unsupported worker action", "INVALID_REQUEST")
        cache = Cache(request.get("cacheDir", ""), request.get("maxBytes", DEFAULT_BUDGET))
        result = sync(request, cache) if action == "sync" else query_data(request, cache, grid=action == "grid")
        emit({"type": "result", "result": result})
        return 0
    except Exception as error:
        details = {"code": getattr(error, "code", "DATA_ERROR"), "message": str(error), "partialCacheRetained": cache is not None,
                   "cacheBytes": cache.used_bytes if cache else 0, "downloadedBytes": cache.downloaded_bytes if cache else 0}
        sys.stderr.write(json.dumps({"error": details}, ensure_ascii=True, allow_nan=False) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
