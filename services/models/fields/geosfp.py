"""NASA GMAO GEOS-FP assimilation (inst3_2d_asm_Nx) on the NCCS OPeNDAP server.

Global 0.25 deg (lat) x 0.3125 deg (lon), 3-hourly instantaneous analyses from
2017-12-01 00Z to near real time. Public, no login. These are model analyses
that assimilate observations; they are not station measurements.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from . import opendap

DATASET = "https://opendap.nccs.nasa.gov/dods/GEOS-5/fp/0.25_deg/assim/inst3_2d_asm_Nx"
COLLECTION = "GEOS-FP inst3_2d_asm_Nx (assimilation, 3-hourly, 2D single-level)"
START = datetime(2017, 12, 1, tzinfo=timezone.utc)
STEP = timedelta(hours=3)
LAT0, DLAT, NY = -90.0, 0.25, 721
LON0, DLON, NX = -180.0, 0.3125, 1152
FILL = 1.0e15
_GRADS_TIME = re.compile(r"(\d{2})z(\d{2})([a-z]{3})(\d{4})")
_MONTHS = {m: i for i, m in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split(), 1)}


def index_for(moment: datetime) -> int:
    return int((moment - START) / STEP)


def time_for(index: int) -> datetime:
    return START + index * STEP


def parse_grads_time(text: str) -> datetime:
    match = _GRADS_TIME.search(text.lower())
    if not match:
        raise ValueError(f"unrecognized GrADS time {text!r}")
    hour, day, month, year = match.groups()
    return datetime(int(year), _MONTHS[month], int(day), int(hour), tzinfo=timezone.utc)


def latest_index() -> int:
    das = opendap.fetch_text(DATASET + ".das")
    block = das[das.index("time {"):]
    maximum = re.search(r'String maximum "([^"]+)"', block)
    if not maximum:
        raise opendap.OpendapError("time maximum not found in DAS")
    return index_for(parse_grads_time(maximum.group(1)))


@dataclass(frozen=True)
class Window:
    """Inclusive index window on the native grid, with a stride."""
    j0: int
    j1: int
    i0: int
    i1: int
    stride: int = 1

    @property
    def ny(self) -> int:
        return (self.j1 - self.j0) // self.stride + 1

    @property
    def nx(self) -> int:
        return (self.i1 - self.i0) // self.stride + 1

    def lats(self) -> list[float]:
        return [LAT0 + (self.j0 + k * self.stride) * DLAT for k in range(self.ny)]

    def lons(self) -> list[float]:
        return [LON0 + (self.i0 + k * self.stride) * DLON for k in range(self.nx)]


def global_window(stride: int) -> Window:
    last_j = (NY - 1) // stride * stride
    last_i = (NX - 1) // stride * stride
    return Window(0, last_j, 0, last_i, stride)


def box_window(lat: float, lon: float, half_lat: float, half_lon: float) -> Window:
    """Native-resolution window around a point (no dateline crossing)."""
    j0 = max(0, math.floor((lat - half_lat - LAT0) / DLAT))
    j1 = min(NY - 1, math.ceil((lat + half_lat - LAT0) / DLAT))
    i0 = max(0, math.floor((lon - half_lon - LON0) / DLON))
    i1 = min(NX - 1, math.ceil((lon + half_lon - LON0) / DLON))
    return Window(j0, j1, i0, i1, 1)


def fetch_frame(index: int, window: Window, variables: list[str]) -> dict[str, list[list[float | None]]]:
    """One analysis time on ``window``: {var: rows south->north of columns west->east}."""
    s = window.stride
    constraints = [opendap.constraint(v, (index, 1, index), (window.j0, s, window.j1), (window.i0, s, window.i1))
                   for v in variables]
    arrays = opendap.fetch_ascii(DATASET, constraints)
    out = {}
    for v in variables:
        array = arrays[v]
        if array.shape[1:] != (window.ny, window.nx):
            raise opendap.OpendapError(f"{v}: shape {array.shape} does not match window {window.ny}x{window.nx}")
        rows = []
        for r in range(window.ny):
            row = array.values[r * window.nx:(r + 1) * window.nx]
            rows.append([None if abs(x) >= FILL * 0.5 or not math.isfinite(x) else x for x in row])
        out[v] = rows
    lat = arrays.get("lat")
    if lat and abs(lat.values[0] - window.lats()[0]) > 1e-6:
        raise opendap.OpendapError("returned latitude does not match the requested window")
    return out
