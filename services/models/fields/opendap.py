"""Minimal OPeNDAP (GrADS Data Server) ASCII client: request text, parse arrays.

Standard library only. The GrADS server at opendap.nccs.nasa.gov answers single
time steps quickly but times out on strided multi-time requests, so callers
request one time step per call.
"""

from __future__ import annotations

import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

USER_AGENT = "flow-field-builder/0.1"
_HEADER = re.compile(r"^(\w+), ((?:\[\d+\])+)$")
_ROW = re.compile(r"^((?:\[\d+\])+), (.*)$")


class OpendapError(RuntimeError):
    pass


@dataclass
class Array:
    name: str
    shape: tuple[int, ...]
    values: list[float]


def _dims(text: str) -> tuple[int, ...]:
    return tuple(int(x) for x in re.findall(r"\[(\d+)\]", text))


def parse_ascii(text: str) -> dict[str, Array]:
    """Parse a GrADS DODS ``.ascii`` response into flat row-major arrays.

    Multi-dimensional blocks look like ``u10m, [1][3][2]`` followed by lines
    ``[0][0], v, v``. One-dimensional map blocks (``lat, [3]``) are followed by
    one comma-separated line. Repeated maps (one copy per variable) are kept once.
    """
    if text.lstrip().startswith("<"):
        raise OpendapError("server returned HTML instead of data: " + re.sub(r"<[^>]+>", " ", text)[:200].strip())
    arrays: dict[str, Array] = {}
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        match = _HEADER.match(lines[i].strip())
        if not match:
            i += 1
            continue
        name, shape = match.group(1), _dims(match.group(2))
        i += 1
        values: list[float] = []
        if len(shape) == 1:
            values = [float(v) for v in lines[i].split(",")] if i < len(lines) and lines[i].strip() else []
            i += 1
        else:
            while i < len(lines) and not _HEADER.match(lines[i].strip()):
                row = _ROW.match(lines[i].strip())
                if row:
                    values.extend(float(v) for v in row.group(2).split(","))
                i += 1
        expected = 1
        for d in shape:
            expected *= d
        if len(values) != expected:
            raise OpendapError(f"{name}: expected {expected} values, parsed {len(values)}")
        if name not in arrays:
            arrays[name] = Array(name, shape, values)
    if not arrays:
        raise OpendapError("no arrays found in response")
    return arrays


def constraint(var: str, *slices: tuple[int, int, int]) -> str:
    """``var[a:s:b][...]`` with each slice as (start, stride, stop), stop inclusive."""
    return var + "".join(f"[{a}:{s}:{b}]" for a, s, b in slices)


def fetch_ascii(dataset_url: str, constraints: list[str], *, timeout: float = 90,
                retries: int = 3) -> dict[str, Array]:
    query = urllib.parse.quote(",".join(constraints), safe=",:")
    url = f"{dataset_url}.ascii?{query}"
    last: Exception | None = None
    for attempt in range(retries):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return parse_ascii(response.read().decode("utf-8", errors="replace"))
        except (urllib.error.URLError, TimeoutError, OpendapError) as error:
            last = error
            time.sleep(2 * (attempt + 1))
    raise OpendapError(f"request failed after {retries} attempts: {last}")


def fetch_text(url: str, *, timeout: float = 60) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")
