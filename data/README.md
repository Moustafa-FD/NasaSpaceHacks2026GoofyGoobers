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


## Part 1 environmental API caches

The Node environmental API added by this backend PR uses the following **ignored local data**, separately from the committed `cloudshadow/` workflow above. The earlier memory-only scenario notes describe the retained starter fixture; active environmental jobs/results are now persisted on disk.

| Path | Current purpose |
| --- | --- |
| `raw/environment/power-grid/` | Original compressed global POWER metadata/chunks and verified coverage/checksum inventory |
| `raw/environment/<hash>.json` | Source responses or environment-relevant extraction records referenced by results |
| `processed/environment/` | NASA catalog/acquisition, facility/emissions snapshots, source-aware query caches, imported evidence and saved results |
| `runs/environment/` | Persisted requests/status/errors and ignored expansion/verification receipts |
| `examples/environment-sync.json`, `examples/environment-series.json` | Redistributable active request examples, not environmental observations |

Source caches and dated verification counts in the handoff are not shipped datasets. Run `npm run data:setup`, start `npm start`, then use `npm run data:sync` / `npm run data:expand` for bounded acquisition. `npm run demo` now reads cached POWER series and requires the global sync first. The old `examples/scenario.json` remains synthetic and is rejected by the active environmental API.

Inspect `/v1/inventory` for actual acquired/valid coverage and cached scopes. POWER's default 768 MiB raw-grid budget does not cap other source/results/job storage. Derived caches generally have a 24-hour TTL; source refreshes and retention need deliberate management. Some retained raw records omit irrelevant contact fields, and JSON hashes may describe serialized parsed payloads rather than original HTTP bytes.

NPRI/EPA scoped snapshots reconcile within-source facility-year identities using newer reports/records; they do not merge OSM, regulator or imported facility identities by proximity. Preserve source units, annual reporting years/media, preliminary flags, estimation methods, nulls and censoring. Do not combine overlapping pollutant totals or interpret missing quantities as zero.

USGS records retain actual station values and source qualifiers; station coverage does not establish universal chemistry or facility impacts. User-supplied ground imports remain unverified, never fetch their reference URLs and perform no acoustic averaging, missing-value substitution or crop-yield inference. No noise/crop-yield dataset is shipped. New Node acquisitions are not automatically copied into `cloudshadow/`, its statistical inputs or Unreal exports.

Completed environmental jobs survive restart; unfinished saved jobs become `INTERRUPTED`. A new POWER sync reuses verified chunks. Terminal write failures can expose `RUN_PERSISTENCE_FAILED` only in memory. Preserve source versions, native cadence/resolution, datum, quality/missing rules, hashes, license and requested/acquired/valid scope. See the [Part 1 handoff](../docs/data-and-backend.md) and [active Node API](../docs/api.md).
