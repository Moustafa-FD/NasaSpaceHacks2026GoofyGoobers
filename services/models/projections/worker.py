"""Part 2 scenario worker for the Node environmental API.

Reads ONE JSON request on stdin; writes progress lines {"type":"progress","progress":0..1,"stage":...}
and ONE final {"type":"result","result":{...}} line to stdout. Errors: {"error":{...}} on stderr, exit 1/2.

    {"model": "plume", "site": {"id","name","lat","lon","neighbors"?}, "heightM", "landUse",
     "emission": {"rateGs", "source", "pollutant"} | null}
    {"model": "climate", "point": {"latitude","longitude"}, "perWindow": 1..4}
"""

from __future__ import annotations

import json
import sys

from . import build, nexgddp, plume


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, allow_nan=False) + "\n")
    sys.stdout.flush()


def run(request: dict) -> dict:
    model = request.get("model")
    if model == "plume":
        site = request["site"]
        prepared = (plume.FIELDS_DIR / str(site.get("id", ""))).is_dir() and site.get("prepared", False)
        if prepared:
            frames = plume.load_site_frames(site["id"])
            source = "prepared GEOS-FP site fields"
        else:
            frames = plume.point_frames(site["lat"], site["lon"], progress=lambda d, n: emit(
                {"type": "progress", "progress": 0.8 * d / n, "stage": "plume:reading-geos-fp-wind"}))
            source = "GEOS-FP point extraction"
        emission = request.get("emission") or {}
        result = plume.scenario(site, height_m=float(request["heightM"]), land_use=request.get("landUse", "urban"),
                                emission_rate_gs=emission.get("rateGs"), emission_source=emission.get("source"),
                                pollutant=emission.get("pollutant"), frames=frames)
        result["assumptions"]["windFrames"] = source
        return result
    if model == "climate":
        point = request["point"]
        site = {"id": "point", "name": f"{point['latitude']:.3f}, {point['longitude']:.3f}", "lat": point["latitude"],
                "lon": point["longitude"]}
        return build.project_point(site, per_window=int(request.get("perWindow", 2)), workers=6, progress=lambda d, n: emit(
            {"type": "progress", "progress": d / n, "stage": "climate:reading-nex-gddp-cmip6"}))
    raise ValueError("model must be plume or climate")


def main() -> int:
    try:
        request = json.loads(sys.stdin.read())
        if not isinstance(request, dict):
            raise ValueError("request must be an object")
        emit({"type": "result", "result": run(request)})
    except (ValueError, KeyError, TypeError, plume.PlumeError, nexgddp.ProjectionError) as error:
        print(json.dumps({"error": {"code": "INVALID_SCENARIO_REQUEST", "message": str(error)}}), file=sys.stderr)
        return 1
    except Exception as error:  # pragma: no cover
        print(json.dumps({"error": {"code": "SCENARIO_WORKER_FAILED", "message": f"{type(error).__name__}: {error}"}}), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
