"""Flow-field product: gridded wind (and optional scalars) shared by the web app and Unreal.

One product = one region (global or a box around a site) and one calendar year,
holding up to N analysis frames. Files:

* ``<name>.json``        manifest (``flow-field/1.0``): grid, frame times, encoding,
                         provenance and, for site boxes, an exact wind series at the site.
* ``<name>.wind.png``    RGB atlas, one tile per frame: R = u (eastward), G = v (northward),
                         B = 255 where valid. 8-bit with a linear scale given in the manifest.
* ``<name>.scalars.png`` optional RGB atlas: R = 2 m air temperature, G = sea-level pressure.

PNG tiles store rows **north to south** (image convention); the manifest's grid gives
cell-centre coordinates. Both clients decode a value as
``min + byte / 255 * (max - min)``.
"""

from __future__ import annotations

import json
import math
import struct
import zlib
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "flow-field/1.0"
WIND_RANGE = (-40.0, 40.0)        # m/s
T2M_RANGE = (200.0, 330.0)        # K
SLP_RANGE = (940.0, 1060.0)       # hPa


# --------------------------------------------------------------------------- PNG
def _chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def write_png_rgb(path: Path, width: int, height: int, rgb: bytes | bytearray) -> None:
    if len(rgb) != width * height * 3:
        raise ValueError("pixel buffer size does not match width*height*3")
    raw = b"".join(b"\x00" + bytes(rgb[y * width * 3:(y + 1) * width * 3]) for y in range(height))
    png = (b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
           + _chunk(b"IDAT", zlib.compress(raw, 9)) + _chunk(b"IEND", b""))
    path.write_bytes(png)


def read_png_rgb(path: Path) -> tuple[int, int, bytes]:
    """Decoder for the files written above (8-bit RGB, filter type 0 only); used in tests."""
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos, idat, width = 8, b"", 0
    while pos < len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if kind == b"IHDR":
            width, height = struct.unpack(">II", body[:8])
        elif kind == b"IDAT":
            idat += body
        pos += 12 + length
    raw = zlib.decompress(idat)
    stride = width * 3 + 1
    return width, height, b"".join(raw[y * stride + 1:(y + 1) * stride] for y in range(height))


# ----------------------------------------------------------------------- encoding
def encode(value: float | None, lo: float, hi: float) -> int:
    if value is None:
        return 128
    return max(0, min(255, round((value - lo) / (hi - lo) * 255)))


def decode(byte: int, lo: float, hi: float) -> float:
    return lo + byte / 255 * (hi - lo)


# ------------------------------------------------------------------------ sampling
def bilinear(grid: list[list[float | None]], lats: list[float], lons: list[float],
             lat: float, lon: float) -> float | None:
    """Bilinear interpolation on a regular grid with rows ordered south->north."""
    if not (lats[0] <= lat <= lats[-1] and lons[0] <= lon <= lons[-1]):
        return None
    dlat = lats[1] - lats[0]
    dlon = lons[1] - lons[0]
    fj = (lat - lats[0]) / dlat
    fi = (lon - lons[0]) / dlon
    j = min(int(fj), len(lats) - 2)
    i = min(int(fi), len(lons) - 2)
    ty, tx = fj - j, fi - i
    corners = (grid[j][i], grid[j][i + 1], grid[j + 1][i], grid[j + 1][i + 1])
    if any(c is None for c in corners):
        return None
    a, b, c, d = corners
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty


def toward_deg(u: float, v: float) -> float:
    """Compass bearing the air moves toward (0 = north, 90 = east)."""
    return (math.degrees(math.atan2(u, v)) + 360.0) % 360.0


# ------------------------------------------------------------------------ schedule
def frame_indices(year: int, frames: int, index_for, first_index: int, last_index: int) -> list[int]:
    """Evenly spaced analysis indices through ``year`` (mid-interval sampling).

    Each frame is snapped to a day boundary and then given a synoptic hour that
    rotates 00, 09, 18, 03, 12, 21, 06, 15 Z, so the set never over-represents one
    time of day (a plain even split hits only two hours in leap years). Indices
    outside the archive (before it starts or after the latest analysis) are dropped.
    """
    from datetime import timezone
    start = index_for(datetime(year, 1, 1, tzinfo=timezone.utc))
    end = index_for(datetime(year + 1, 1, 1, tzinfo=timezone.utc))
    n = end - start
    chosen = []
    for k in range(frames):
        offset = int((k + 0.5) * n / frames)
        offset = offset - offset % 8 + (k * 3) % 8          # 8 steps per day of 3 h
        chosen.append(start + min(offset, n - 1))
    return [i for i in chosen if first_index <= i <= last_index]


# ------------------------------------------------------------------------- product
@dataclass
class Frame:
    time: datetime
    index: int
    u: list[list[float | None]]
    v: list[list[float | None]]
    t2m: list[list[float | None]] | None = None
    slp_hpa: list[list[float | None]] | None = None


@dataclass
class FlowField:
    product_id: str
    kind: str                      # "global" | "site"
    year: int
    lats: list[float]              # cell centres, south -> north
    lons: list[float]              # cell centres, west -> east
    source: dict[str, Any]
    frames: list[Frame] = field(default_factory=list)
    site: dict[str, Any] | None = None
    expected_frames: int = 0

    def atlas_layout(self) -> tuple[int, int]:
        cols = min(len(self.frames), 4) or 1
        rows = math.ceil(len(self.frames) / cols) or 1
        return cols, rows

    def _atlas(self, channels) -> tuple[int, int, bytearray]:
        nx, ny = len(self.lons), len(self.lats)
        cols, rows = self.atlas_layout()
        width, height = cols * nx, rows * ny
        buf = bytearray(width * height * 3)
        for f, frame in enumerate(self.frames):
            ox, oy = (f % cols) * nx, (f // cols) * ny
            layers = channels(frame)
            for r in range(ny):
                src = ny - 1 - r                     # north -> south in the image
                for c in range(nx):
                    p = ((oy + r) * width + ox + c) * 3
                    for k, (grid, lo, hi, constant) in enumerate(layers):
                        if constant is not None:
                            buf[p + k] = constant(frame, src, c)
                        else:
                            buf[p + k] = encode(grid[src][c] if grid else None, lo, hi)
        return width, height, buf

    def write(self, out_dir: Path, name: str) -> dict[str, Any]:
        out_dir.mkdir(parents=True, exist_ok=True)
        if not self.frames:
            raise ValueError("no frames to write")
        nx, ny = len(self.lons), len(self.lats)
        cols, rows = self.atlas_layout()

        def valid(frame: Frame, r: int, c: int) -> int:
            return 255 if frame.u[r][c] is not None and frame.v[r][c] is not None else 0

        w, h, wind = self._atlas(lambda fr: [(fr.u, *WIND_RANGE, None), (fr.v, *WIND_RANGE, None), (None, 0, 1, valid)])
        write_png_rgb(out_dir / f"{name}.wind.png", w, h, wind)
        files = {"wind": f"{name}.wind.png"}
        has_scalars = all(fr.t2m is not None and fr.slp_hpa is not None for fr in self.frames)
        if has_scalars:
            w, h, scal = self._atlas(lambda fr: [(fr.t2m, *T2M_RANGE, None), (fr.slp_hpa, *SLP_RANGE, None),
                                                 (None, 0, 1, lambda *_: 0)])
            write_png_rgb(out_dir / f"{name}.scalars.png", w, h, scal)
            files["scalars"] = f"{name}.scalars.png"

        speeds = [math.hypot(fr.u[r][c], fr.v[r][c]) for fr in self.frames for r in range(ny) for c in range(nx)
                  if fr.u[r][c] is not None and fr.v[r][c] is not None]
        manifest: dict[str, Any] = {
            "schemaVersion": SCHEMA_VERSION,
            "id": self.product_id,
            "kind": self.kind,
            "year": self.year,
            "evidence": "model_analysis",
            "evidenceNote": ("GEOS-FP analyses combine a weather model with assimilated observations. Wind here is the "
                             "real large-scale flow at each frame time; it is not a measured pollutant concentration, "
                             "and any tracer/plume moved by it in a client is a visualization."),
            "source": self.source,
            "grid": {
                "nx": nx, "ny": ny,
                "lonMin": self.lons[0], "lonMax": self.lons[-1], "latMin": self.lats[0], "latMax": self.lats[-1],
                "dLon": self.lons[1] - self.lons[0] if nx > 1 else None,
                "dLat": self.lats[1] - self.lats[0] if ny > 1 else None,
                "wrapsLongitude": self.kind == "global",
                "pngRowOrder": "north-to-south",
            },
            "frames": [{"time": fr.time.strftime("%Y-%m-%dT%H:%MZ"), "sourceIndex": fr.index} for fr in self.frames],
            "framesExpected": self.expected_frames,
            "complete": len(self.frames) == self.expected_frames,
            "atlas": {"cols": cols, "rows": rows, "tileWidth": nx, "tileHeight": ny, "order": "row-major, frame 0 top-left"},
            "files": files,
            "encoding": {
                "formula": "value = min + byte / 255 * (max - min)",
                "wind": {"R": {"variable": "u10m", "meaning": "eastward wind at 10 m", "unit": "m/s", "min": WIND_RANGE[0], "max": WIND_RANGE[1]},
                         "G": {"variable": "v10m", "meaning": "northward wind at 10 m", "unit": "m/s", "min": WIND_RANGE[0], "max": WIND_RANGE[1]},
                         "B": {"meaning": "255 = valid cell, 0 = missing"}},
            },
            "stats": {"meanSpeed": round(sum(speeds) / len(speeds), 3) if speeds else None,
                      "maxSpeed": round(max(speeds), 3) if speeds else None},
        }
        if has_scalars:
            manifest["encoding"]["scalars"] = {
                "R": {"variable": "t2m", "meaning": "air temperature at 2 m", "unit": "K", "min": T2M_RANGE[0], "max": T2M_RANGE[1]},
                "G": {"variable": "slp", "meaning": "sea-level pressure", "unit": "hPa", "min": SLP_RANGE[0], "max": SLP_RANGE[1]},
            }
        if self.site:
            manifest["site"] = self.site
            manifest["siteSeries"] = self.site_series()
        (out_dir / f"{name}.json").write_text(json.dumps(manifest, indent=1, allow_nan=False), encoding="utf-8")
        return manifest

    def site_series(self) -> list[dict[str, Any]]:
        lat, lon = self.site["lat"], self.site["lon"]
        series = []
        for fr in self.frames:
            u = bilinear(fr.u, self.lats, self.lons, lat, lon)
            v = bilinear(fr.v, self.lats, self.lons, lat, lon)
            row: dict[str, Any] = {"time": fr.time.strftime("%Y-%m-%dT%H:%MZ")}
            if u is not None and v is not None:
                row.update(u=round(u, 2), v=round(v, 2), speed=round(math.hypot(u, v), 2), towardDeg=round(toward_deg(u, v), 1))
            if fr.t2m is not None:
                t = bilinear(fr.t2m, self.lats, self.lons, lat, lon)
                row["t2mK"] = None if t is None else round(t, 2)
            if fr.slp_hpa is not None:
                p = bilinear(fr.slp_hpa, self.lats, self.lons, lat, lon)
                row["slpHpa"] = None if p is None else round(p, 2)
            series.append(row)
        return series
