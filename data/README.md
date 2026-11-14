# Data conventions

`examples/scenario.json` is entirely synthetic. Its bounding box is a UI example, not evidence about a location, facility, tariff or environmental condition.

`cloudshadow/` is the exception: a small, committed, **real NASA-derived** dataset for the trend-detective demo (≈1 MB), produced by `npm run data:nasa` (`scripts/precompute.py`) from NASA GIBS tiles decoded with the official GIBS colormaps:

- `sites.json`: case-study facilities, start dates, stories and a sourced ledger (each entry labelled `reported`, `estimate`, `requested`, `disputed` or `unverified`, with source URL).
- `series/<site>.json`: monthly site (3×3 px) vs. surrounding-ring means for MODIS LST day/night & NDVI, MODIS AOD, Sentinel-5P TROPOMI NO₂, Aura OMI NO₂ and MERRA-2 2 m air temperature. Retrieval date in `generated`.
- `gibs_layers.json`: GIBS tile-matrix sets and date ranges; `hls_dates.json`: cloud-screened HLS before/after dates; `cm_*.xml`: the GIBS colormaps used for decoding.
- `unreal/`: `npm run data:unreal` export (DataTable CSV + JSON + yearly series CSVs).

These are rendered-product values (colour-class midpoints), not Level-2 science retrievals with quality flags, and are labelled as such in the app. No utility data is included.

- `raw/`: immutable, dated source downloads and acquisition metadata; ignored by Git.
- `processed/`: quality-controlled, unit-normalized tables/raster products; ignored by Git.
- `runs/`: future persisted scenario manifests, charts and layer artifacts; ignored by Git. The current API stores runs in memory only.
- `examples/`: small, redistributable synthetic inputs suitable for tests and demonstration.

Future acquired datasets need source URL/DOI, collection/version, retrieval date, license, geographic/time coverage, units, quality flags, processing steps and checksum. Credentials and Earthdata login files must stay outside Git. See [resource catalog](../docs/resources.md) and [modeling rules](../docs/modeling.md).
