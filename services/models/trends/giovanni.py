"""Giovanni area-averaged time series (via NASA Harmony) for the case-study sites.

    python -m services.models.trends.giovanni                         # default variable set, all sites
    python -m services.models.trends.giovanni --sites ashburn --variables GPM_3IMERGM_07_precipitation

Needs EARTHDATA_TOKEN (environment or .env). The Earthdata account must have
accepted the GES DISC licence and signed in to Giovanni once. The token is sent
only to NASA hosts and is never printed. Downloads go to data/raw/giovanni/<site>/
(ignored by Git) with a provenance JSON next to each CSV. Existing files are
skipped, so re-running only fetches what is missing; the run then ends.
Giovanni has a monthly compute quota; the remaining fraction is printed first.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SITES_FILE = ROOT / "data" / "cloudshadow" / "sites.json"
OUT_DIR = ROOT / "data" / "raw" / "giovanni"
HARMONY = "https://harmony.earthdata.nasa.gov"
QUOTA = "https://api.giovanni.earthdata.nasa.gov/quota"
CMR = "https://cmr.earthdata.nasa.gov/search/collections.json"
NASA_HOSTS = (".earthdata.nasa.gov", ".nasa.gov")


@dataclass(frozen=True)
class Variable:
    giovanni_id: str
    short_name: str
    version: str
    start: str
    label: str


DEFAULT_VARIABLES = (
    Variable("GPM_3IMERGM_07_precipitation", "GPM_3IMERGM", "07", "2001-01-01", "Precipitation (GPM IMERG monthly)"),
    Variable("GLDAS_NOAH025_M_2_1_SoilMoi0_10cm_inst", "GLDAS_NOAH025_M", "2.1", "2001-01-01", "Topsoil moisture 0-10 cm (GLDAS)"),
    Variable("GLDAS_NOAH025_M_2_1_Evap_tavg", "GLDAS_NOAH025_M", "2.1", "2001-01-01", "Evapotranspiration (GLDAS)"),
    Variable("GRACEDADM_CLSM0125US_7D_4_0_gws_inst", "GRACEDADM_CLSM0125US_7D", "4.0", "2003-02-01", "Groundwater storage (GRACE data assimilation, US)"),
    Variable("OMNO2d_003_ColumnAmountNO2TropCloudScreened", "OMNO2d", "003", "2005-01-01", "Tropospheric NO2 column (Aura OMI)"),
)


class GiovanniError(RuntimeError):
    pass


def load_token(env_file: Path = ROOT / ".env") -> str:
    token = os.environ.get("EARTHDATA_TOKEN", "").strip()
    if not token and env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("EARTHDATA_TOKEN="):
                token = line.split("=", 1)[1].strip().strip("\"'")
    if not token:
        raise GiovanniError("EARTHDATA_TOKEN is not set (environment or .env)")
    return token


def site_bbox(lat: float, lon: float, half_deg: float) -> tuple[float, float, float, float]:
    return (round(lon - half_deg, 4), round(lat - half_deg, 4), round(lon + half_deg, 4), round(lat + half_deg, 4))


def rangeset_url(concept_id: str, variable: str, bbox: tuple[float, float, float, float], start: str, stop: str) -> str:
    w, s, e, n = bbox
    query = [("subset", f"lon({w}:{e})"), ("subset", f"lat({s}:{n})"), ("subset", f'time("{start}":"{stop}")'),
             ("format", "text/csv"), ("average", "area"), ("forceAsync", "true")]
    return (f"{HARMONY}/{concept_id}/ogc-api-coverages/1.0.0/collections/{urllib.parse.quote(variable)}"
            f"/coverage/rangeset?{urllib.parse.urlencode(query)}")


class Client:
    def __init__(self, token: str, timeout: float = 180):
        self.token, self.timeout = token, timeout

    def get(self, url: str, *, auth: bool = True) -> bytes:
        host = urllib.parse.urlsplit(url).hostname or ""
        send_token = auth and host.endswith(NASA_HOSTS)
        request = urllib.request.Request(url, headers={"Authorization": f"Bearer {self.token}"} if send_token else {})
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            return response.read()

    def quota_used(self) -> float:
        return float(json.loads(self.get(QUOTA))["quota"])

    def concept_id(self, short_name: str, version: str) -> str:
        data = json.loads(self.get(f"{CMR}?short_name={short_name}&version={version}", auth=False))
        entries = data["feed"]["entry"]
        if not entries:
            raise GiovanniError(f"collection {short_name} v{version} not found in CMR")
        return entries[0]["id"]

    def area_average(self, concept_id: str, variable: str, bbox, start: str, stop: str, poll_seconds: float = 4,
                     max_wait: float = 900) -> tuple[bytes, dict]:
        try:
            job = json.loads(self.get(rangeset_url(concept_id, variable, bbox, start, stop)))
        except urllib.error.HTTPError as error:
            raise GiovanniError(f"submit failed: HTTP {error.code} {error.read()[:300].decode(errors='replace')}") from error
        deadline = time.time() + max_wait
        while job.get("status") not in ("successful", "failed", "canceled", "complete_with_errors"):
            if time.time() > deadline:
                raise GiovanniError(f"job {job.get('jobID')} still {job.get('status')} after {max_wait:.0f}s")
            time.sleep(poll_seconds)
            job = json.loads(self.get(f"{HARMONY}/jobs/{job['jobID']}"))
        if job["status"] != "successful":
            raise GiovanniError(f"job {job.get('jobID')} {job['status']}: {job.get('message', '')[:300]}")
        links = [link["href"] for link in job.get("links", []) if link.get("rel") == "data"]
        if len(links) != 1:
            raise GiovanniError(f"expected one CSV result, got {len(links)}")
        return self.get(links[0]), job


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Download Giovanni area-averaged CSVs for case-study sites.")
    parser.add_argument("--sites", default="all")
    parser.add_argument("--variables", default="", help="comma-separated Giovanni IDs from the default set")
    parser.add_argument("--half-deg", type=float, default=0.25, help="half-width of the site box in degrees")
    parser.add_argument("--stop", default="2025-12-31", help="last date (inclusive)")
    parser.add_argument("--max-quota", type=float, default=0.8, help="stop when this fraction of the monthly quota is used")
    parser.add_argument("--out", default=str(OUT_DIR))
    args = parser.parse_args(argv)

    variables = [v for v in DEFAULT_VARIABLES if not args.variables or v.giovanni_id in args.variables.split(",")]
    sites = json.loads(SITES_FILE.read_text(encoding="utf-8"))["sites"]
    if args.sites != "all":
        sites = [s for s in sites if s["id"] in args.sites.split(",")]
    client = Client(load_token())
    used = client.quota_used()
    print(f"Giovanni quota used this month: {used:.0%}", file=sys.stderr)
    concepts = {v.short_name + v.version: client.concept_id(v.short_name, v.version) for v in variables}
    fetched = skipped = failed = 0
    for site in sites:
        bbox = site_bbox(site["lat"], site["lon"], args.half_deg)
        for v in variables:
            dest = Path(args.out) / site["id"] / f"{v.giovanni_id}.csv"
            if dest.exists():
                skipped += 1
                continue
            if used >= args.max_quota:
                print(f"stopping: quota {used:.0%} reached --max-quota {args.max_quota:.0%}", file=sys.stderr)
                break
            started = time.time()
            try:
                body, job = client.area_average(concepts[v.short_name + v.version], v.giovanni_id, bbox,
                                                f"{v.start}T00:00:00Z", f"{args.stop}T23:59:59Z")
            except (GiovanniError, urllib.error.URLError, TimeoutError) as error:
                failed += 1
                print(f"{site['id']} {v.giovanni_id}: FAILED {error}", file=sys.stderr)
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(body)
            provenance = {"site": site["id"], "variable": v.giovanni_id, "label": v.label, "collection": v.short_name,
                          "version": v.version, "conceptId": concepts[v.short_name + v.version], "bbox": list(bbox),
                          "start": v.start, "stop": args.stop, "harmonyJobId": job.get("jobID"),
                          "service": "Giovanni area-average via NASA Harmony (average=area, format=text/csv)",
                          "retrievedUtc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
            dest.with_suffix(".provenance.json").write_text(json.dumps(provenance, indent=2), encoding="utf-8")
            fetched += 1
            used = client.quota_used()
            print(f"{site['id']} {v.giovanni_id}: {len(body)} bytes in {time.time() - started:.0f}s (quota {used:.0%})",
                  file=sys.stderr)
    print(f"done: {fetched} fetched, {skipped} already present, {failed} failed", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
