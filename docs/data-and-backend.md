# 1. Data and backend

> **Implementation availability:** this backend PR includes Footprint Atlas's expanded Node environmental API, alongside the existing web explorer, NASA-data pipeline, statistical methods and Unreal project. Use this PR checkout before merge, or a main checkout containing it afterward. Source code and reproducible acquisition commands are included; downloaded caches, saved runs and verification receipts remain local and are not shipped. The dated verification below comes from the reference implementation at `71d263d` on 2026-11-14.

Code paths, imports and commands below refer to this repository checkout. The active Node contract is `packages/contracts/src/environment.ts` and the expanded [API documentation](api.md). The old accounting JSON Schemas and Python worker remain fixtures; their scenario bodies are no longer accepted by the environmental API.

## Purpose and boundary

Part 1 acquires environmental evidence, preserves source definitions/provenance, maintains bounded local caches and exposes asynchronous requests/results. Coverage is global where supported, with Canada/USA investigation priority. Source availability, actual locally acquired coverage and finite observations are separate facts.

Part 2 can consume historical series, official emissions records, station observations and conditional climate simulations. The Node environmental API does not yet expose statistical trend jobs. Part 2 should evaluate and integrate the existing main statistical work rather than assume it must start from zero, then validate methods and any new environmental-impact models against their intended evidence. Electricity bills, labor and population projections are outside the current environmental scope.

Existing agriculture calculations provide climate-exposure indicators. They do not predict crop yield, agricultural suitability or damage attributable to a data center. This Node environmental API provides no calibrated facility-attribution, pollutant-transport, acoustic-propagation or comprehensive water-chemistry model.

## Coexisting web, NASA, statistics and Unreal work

The [web team guide](../apps/web/README.md) describes the existing browser/Unreal workflow; this handoff does not replace it or independently establish its scientific validation.

| Main implementation | Current interface and integration boundary |
| --- | --- |
| `apps/web/server.cjs` | `npm run web`, default port 8765; `/api/sites`, `/api/analysis?site=&var=`, `/api/layers` and variable/date layer requests. Separate from the Node environmental `/v1` API. |
| `data/cloudshadow/`, `scripts/summary.cjs`, NASA pipeline scripts | Committed site datasets and exports used by the web workflow. Its monthly `t/site/ref` arrays are not automatically mapped to the Node environmental cache/result shapes. |
| `apps/web/js/stats.js` | Existing Mann-Kendall, Sen's slope, deseasonalization and Welch/before-after routines. Review assumptions/numerical checks and adapt their input/evidence contract when reusing them. |
| Web layers and Unreal work | Main supplies Cesium GIBS WMTS templates plus an Unreal project/timeline exports. Those are separate from the native grid JSON and job results documented here. |

Main's GIBS-derived series use decoded color-class midpoints, which must be distinguished from quality-controlled source science pixels. Its trend extrapolations through 2035 are separate from the Node environmental HighResMIP climate simulations through 2050-01-01; their uncertainty meanings are not interchangeable.

No automatic connection between these workflows is implemented. The web server does not proxy `/v1`, and the Node environmental API has no browser CORS configuration; browser requests from port 8765 to 3000 need an implemented proxy/CORS integration. Both servers read `PORT`, so assign distinct values when running them together. A static GitHub Pages deployment does not host either Node API. Preserve existing main work while designing this integration.

Two possible integration paths are a new Node analysis job that maps aligned Part 1 series into the existing statistics inputs, or an offline exporter into the web/Unreal `data/cloudshadow` formats. `scripts/summary.cjs` exposes the existing `Stats` implementation, whose analysis input uses monthly `t/site/ref` arrays. Select the comparison/reference explicitly and preserve source definitions. Neither bridge/exporter currently exists; the browser reads static site/series files, and `web:build` does not copy the ignored environmental caches.

## Verified local snapshot

These are dated Node environmental acquisition/plumbing results, not scientific accuracy or predictive-skill validation. Its ignored caches/receipts are separate from the datasets already committed under main's `data/cloudshadow/`.

| Source | Verified local result on 2026-11-14 | Interpretation |
| --- | --- | --- |
| NASA POWER | Four variables, each 260/260 spatial chunks; 549 valid months, January 1981-September 2026; 361 x 576 native global grid; approximately 516.15 MiB source files excluding inventory | Historical model-derived meteorology, not all NASA archives |
| OpenStreetMap | 5,067 located source elements; 2,024 inside example bbox `[-170,5,-50,85]` | Map elements can duplicate a physical campus. This bbox is not a country border or census. |
| Canada NPRI | 34 facility-year reports, five sector candidates, 128 pollutant/media rows, nine non-null quantities | Not 128 measured emissions values; missing quantities remain unknown |
| US EPA NEI | 23,096 records over 2008/2011/2014/2017/2020/2023, across 309 distinct source facility IDs; 2023 has 7,026 records, 251 candidates and 85 pollutants | Selected inventory years and source IDs, not continuous annual coverage or confirmed data-center identities |
| USGS | 1,440 records across five parameters for `USGS-01646500`, 2026-11-01; provisional/source metadata retained | Actual station records, not global water-chemistry coverage |
| Regional examples | Canada and US air-quality, ERA5, two-model future climate and agricultural comparisons completed | Bounded point examples, not every global environmental grid |

All **17 expansion jobs** completed. Local receipts are `data/runs/environment/live-verification.json` and `data/runs/environment/expanded-verification.json`; both explicitly record `scientificValidation: false`. The expansion plan/results are tracked in `data/runs/environment/expansion-report.json`.

## Implementation map

| Repository path | Responsibility |
| --- | --- |
| `packages/contracts/src/environment.ts` | Active `EnvironmentRequest` union, `EnvironmentRun`, capability registry and runtime validation |
| `apps/api/src/server.ts` | Loopback HTTP API, read-only WebSocket status and ground-record validation |
| `apps/api/src/environment/service.ts` | `environmentExecutor`, adapter dispatch, caching/persistence and Python-grid bridge |
| `apps/api/src/environment/jobs.ts` | `EnvironmentJobs`: bounded queue, lifecycle, status notifications and restart handling |
| `apps/api/src/environment/store.ts` | `EnvironmentStore`: local directories, JSON reads/writes, SHA-256 keys and atomic replacement |
| `apps/api/src/environment/library.ts` | Facility/emissions browsing, cached-scope reconciliation and inventory summaries |
| `apps/api/src/environment/*.ts` | Typed source adapters and agricultural exposure calculations |
| `services/data/power_grid.py` | NumPy/numcodecs acquisition and decoding of compressed POWER global chunks |
| `services/models/worker.py` | Retained illustrative accounting worker; **not** an active environmental analysis worker |

The active environmental contract is TypeScript plus runtime validators. `packages/contracts/src/index.ts` and `packages/contracts/schemas/scenario.schema.json` / `result.schema.json` belong to the inactive accounting fixture, despite sharing a `1.0` version label.

## Running this checkout

Use a checkout containing this backend PR. Install dependencies and start the Node API; acquisition is a separate explicit step.

```sh
git branch --show-current
git rev-parse --short HEAD
# Before merge: codex/part1-backend; afterward use main containing this backend
npm ci
npm run data:setup
npm start
```

Requirements are Node 24.12+ (supported majors 24-26), npm and Python 3.11+ available as `python`. `data:setup` creates `.venv` and installs NumPy/numcodecs. No GPU or Unreal installation is required. Before submitting work, check `GET http://127.0.0.1:3000/health` returns:

```json
{"status":"ok","schemaVersion":"1.0","mode":"environmental","persistence":"local-files"}
```

If `mode` is not `environmental`, you are connected to another/older API; check the checkout, process and port before applying these requests. Optional `.env` settings are `PORT`, `API_BASE_URL` for CLI clients, `PYTHON_EXECUTABLE`, `DATA_PYTHON_EXECUTABLE` and `DATA_WORKER_TIMEOUT_MS`. The data helper chooses explicit `DATA_PYTHON_EXECUTABLE`, otherwise local `.venv`, otherwise `PYTHON_EXECUTABLE`/`python`. Credentials must remain outside Git and Unreal assets. `data:setup` installs the POWER helper's NumPy/numcodecs dependencies; it does not install every separate NASA web-pipeline dependency. On Windows the helper automatically uses `.venv/Scripts/python.exe`, on Linux/macOS `.venv/bin/python`; activation is unnecessary for this helper. CI installs data dependencies before offline `check` on Windows and Linux. The retained `test:models` command still requires `python` on PATH.

`npm start` now exposes environmental jobs. `npm run demo` is a cached POWER-series query and needs a completed `data:sync`; it no longer runs the synthetic accounting example. Legacy schemas/worker remain regression fixtures and do not expose economic domains through this API. The web commands and `/api` endpoints retain their separate workflow.

In another terminal, from this checkout:

```sh
npm run data:sync             # POWER global history + curated CMR discovery
npm run demo                  # Cached global series, Jan 2015-Sep 2026
npm run data:verify           # Optional live POWER data-plumbing checks
npm run data:expand           # Bounded facility/inventory/regional/USGS plan
npm run data:verify-expanded  # Optional live checks after expansion completes
npm run check                # Offline type/fixture/regression checks
```

`data:expand` reuses completed matching run IDs, records failures and refuses duplicate active work. After an upstream quota cooldown, rerun it to retry failed work. `npm run data:expand -- --refresh` deliberately resubmits completed requests. A partial expansion is not overall completion. Live verification is separate from offline `check` and does not validate model accuracy.

## HTTP and job contract

| Method/path | Implemented behavior |
| --- | --- |
| `GET /health` | Identify the environmental implementation |
| `GET /v1/domains`, `/v1/sources` | Capabilities, access/evidence definitions and limitations |
| `GET /v1/catalog` | Curated NASA CMR collection metadata; not acquired observations |
| `GET /v1/inventory` | Raw-cache bytes, POWER inventory/acquisition, source `datasets`, geographic priority and warnings |
| `GET /v1/facilities` | Paginated cached source-specific facility records |
| `GET /v1/emissions` | Paginated cached annual release/inventory records |
| `POST /v1/runs` | Validate one supported request and return a job ID immediately |
| `GET /v1/runs/{id}` | Authoritative current status, submitted `request`, stage/details and errors |
| `GET /v1/runs/{id}/results` | Completed source-specific result; otherwise `409` |
| `WS /v1/runs/{id}/events` | Immediate current snapshot followed by status/progress changes |

Submit JSON with `Content-Type: application/json`. Every active request requires `schemaVersion: "1.0"` and a supported `kind`; unknown fields are rejected. A successful POST returns `202`:

```json
{
  "id":"<run-id>","status":"queued",
  "statusUrl":"/v1/runs/<run-id>",
  "resultUrl":"/v1/runs/<run-id>/results",
  "eventsUrl":"/v1/runs/<run-id>/events"
}
```

Resolve those paths against the configured API origin. States are `queued -> running -> completed | failed`. The run envelope is:

```ts
interface EnvironmentRun {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  stage: string;
  createdAt: string;
  updatedAt: string;
  request: EnvironmentRequest;
  details?: Record<string, unknown>;
  error?: { code: string; message: string };
  resultUrl?: string;
}
```

WebSocket messages are `{type:"run.status",run:...}`. The first message is a latest-state snapshot, not replayed history. Polling HTTP status is also supported. After reconnect, fetch HTTP status before waiting again. Fetch results after completion; failed results also return `409`. Incoming socket controls close the status-only stream. There is no cancellation/pause/resume, durable event replay, raw-file download route or tile/layer-serving route.

## Supported requests and defaults

Coordinates are finite WGS84 latitude/longitude. Bboxes are ordered `[west,south,east,north]` and do not cross the antimeridian. Daily ranges are inclusive; date validation does not guarantee finite source records exist.

| `kind` | Fields/defaults and bounds |
| --- | --- |
| `sync` | Optional unique `variables` from `T2M,PRECTOTCORR,RH2M,WS2M`, default all four; `maxCacheMiB` 64-1024, default 768; optional `refreshCatalog`. No geography/date/source field. |
| `series` | `source: power-grid|power-point`, ordered monthly `start/end`, 1981-01..current UTC month; optional supported variables. Grid series requires point or bbox; REST requires point. Omitted variables default to T2M for grid and all four for REST. |
| `grid` | `source: power-grid`, exactly one supported variable and monthly `date`; returns a native global frame, with no spatial selection. |
| `facilities-sync` | Optional bbox; omitted means bounded global OSM tagged-element query. |
| `emissions-sync`, `source:npri` | Optional `startYear/endYear`, default source-available range; historical years from 1993; `maxReports` 1-100, default 100. Newest reports requested first; truncation explicit. |
| `emissions-sync`, `source:epa-nei` | Optional `year` in 2008/2011/2014/2017/2020/2023, default 2023; optional supported two-letter state/territory postal code. |
| `air-quality` | `point`; optional paired daily `start/end`, default last seven completed UTC days; 1-31 days from 2022-08-01 through yesterday; optional unique pollutant IDs, default all five. |
| `water-quality` | `stationId: USGS-` + 8-15 digits; daily `start/end`, 1900..today, up to 31 days; optional unique parameter codes, default all five. Actual history depends on station/parameter. |
| `land-water` | `point`, daily `start/end`, 1940..at least five days ago; end-minus-start at most 731 days. |
| `climate` | `point`, daily `start/end` within 1950-01-01..2050-01-01; end-minus-start at most 3660 days; optional one/two models, default both supported models. |
| `agriculture` | `point`, complete-calendar-year `baseline` and `future` periods within 1950-2049, up to ten years each; future follows baseline and starts after today; explicit months/thresholds; optional models. |
| `ground-evidence` | 1-100 source-referenced records, subject to detailed validation and the common 64 KiB body limit. |

### Historical POWER series and native frame

```json
{"schemaVersion":"1.0","kind":"series","source":"power-grid","variables":["T2M","PRECTOTCORR"],"point":{"latitude":39,"longitude":-77.5},"start":"2024-01","end":"2024-12"}
```

```json
{"schemaVersion":"1.0","kind":"grid","source":"power-grid","variables":["T2M"],"date":"2026-09"}
```

Source identity is `nasa-power-merra2-monthly-utc`, whereas the request's source selector is `power-grid`. Grid series returns `metrics[]` with `variable`, `units`, definition/aggregation metadata and samples `{date,value,validCellCount,totalCellCount,coverageFraction}`. A point uses the nearest native cell. A bbox includes cell centers and spherical latitude-band weights, not exact polygon-edge fractions. All intersecting chunks must exist and verify; partial tile downloads are not opportunistically averaged.

Grid results contain `grid.latitudes`, `longitudes`, `shape`, flat `values` and order `latitude-major rows, longitude-minor columns`. Missing values are null. This is JSON, not Cesium-ready layer URLs. Allocated future Zarr slots contain missing data; actual valid coverage is calculated from numeric history. Spatial chunks contain the encoded time dimension, so recent months cannot be downloaded independently of older bytes in the same chunk.

### Modeled ambient air and observed station water quality

```json
{"schemaVersion":"1.0","kind":"air-quality","point":{"latitude":39,"longitude":-77.5},"start":"2026-11-01","end":"2026-11-07","variables":["pm2_5","pm10","nitrogen_dioxide","ozone","sulphur_dioxide"]}
```

```json
{"schemaVersion":"1.0","kind":"water-quality","stationId":"USGS-01646500","start":"2026-11-01","end":"2026-11-01","parameters":["00010","00095","00400","00300","63680"]}
```

CAMS output is `model-derived`, UTC, with `variables[].unit` and `series[{date,value,quality}]`, valid/missing counts, first/last finite dates, requested/reported point, native scale and license. August 2022 archive bounds do not guarantee numeric values at every location/date. Operational model changes matter for trend comparability.

USGS codes mean temperature `00010`, conductance `00095`, pH `00400`, dissolved oxygen `00300` and turbidity `63680`. Output is `ground-observation`, with individual irregular records: parameter/time-series/statistic IDs, source/UTC timestamps, `rawValue`, numeric/null `value`, raw `unit`, approval/qualifier/method metadata and station geometry/original datum. Example source units include `degC`, `uS/cm`, `pH Units`, `mg/l` and `_FNU`; preserve them rather than relabeling.

Censored values retain operator/bound with null numeric value. Bounds are not assumed laboratory detection limits. Provisional/estimated qualifiers remain visible. Default acquisition caps are 20,000 records and 32 MiB total, with a 4 MiB per-document limit. `complete` means requested pagination exhausted, not continuous monitoring or every parameter measured. Discharge is not substituted for chemistry; there is no comprehensive chemistry, potability or facility-impact inference.

### Daily land/water and conditional climate inputs

```json
{"schemaVersion":"1.0","kind":"land-water","point":{"latitude":39,"longitude":-77.5},"start":"2024-01-01","end":"2025-12-31"}
```

```json
{"schemaVersion":"1.0","kind":"climate","point":{"latitude":39,"longitude":-77.5},"start":"2040-01-01","end":"2049-12-31","models":["EC_Earth3P_HR","MRI_AGCM3_2_S"]}
```

Both return `models[{model,metrics[{id,sourceVariable,units,series:[{date,value}],validDays,missingDays}]}]`, source/requested points, time standard, source URL/hash, scenario/license and warnings. Variables are daily mean/max/min temperature, precipitation sum, reference ET0 and modeled soil moisture. ERA5 has 0-7, 7-28 and 28-100 cm moisture; supported climate models provide 0-10 cm. Do not treat those depths as interchangeable observations.

ERA5 is historical `model-derived` context at approximately 0.25 degrees. HighResMIP is `climate-scenario`: `EC_Earth3P_HR` / `MRI_AGCM3_2_S`, provider downscaling around 10 km, native scales around 20-29 km, high forcing described as close to RCP8.5. There is no selectable SSP, output beyond 2050-01-01 or particular-day future weather forecast. Historical climate-simulation dates are also not actual historical weather. Two-model spread is not a confidence interval.

### Existing agricultural climate-exposure calculation

```json
{
  "schemaVersion":"1.0","kind":"agriculture","point":{"latitude":39,"longitude":-77.5},
  "baseline":{"start":"1991-01-01","end":"2000-12-31"},
  "future":{"start":"2040-01-01","end":"2049-12-31"},
  "models":["EC_Earth3P_HR","MRI_AGCM3_2_S"],"growingMonths":[4,5,6,7,8,9],
  "baseTemperatureC":10,"heatThresholdC":30,"dryDayThresholdMm":1
}
```

Months must be unique 1-12; base temperature is -10..40 C, heat threshold greater than base and at most 60 C, dry threshold 0..20 mm. These are explicit user screening assumptions, not universal crop limits.

`agricultureIndicators` calculates selected-season mean temperature, GDD `sum(max(0,Tmean-base))`, Tmax days above the heat threshold, Tmin days below zero, rainfall days below the dry threshold, precipitation/ET0 totals, their difference and mean surface moisture. Incomplete seasons or missing required values produce null. Calendar-year grouping does not model cross-year crop phenology.

`compareAgriculture` requires like-for-like climate-simulation inputs and returns yearly values plus per-model seasonal means/change. Evidence is `conditional-climate-screening`; unavailable metrics explicitly include crop yield, data-center-attributable crop effects and pollution-crop damage. Short periods may reflect natural variability; significance is not computed.

### Facility/releases acquisition and browsing

```json
{"schemaVersion":"1.0","kind":"facilities-sync"}
```

```json
{"schemaVersion":"1.0","kind":"emissions-sync","source":"npri","maxReports":100}
```

```json
{"schemaVersion":"1.0","kind":"emissions-sync","source":"epa-nei","year":2023,"state":"VA"}
```

Browse cached data with `/v1/facilities?source=osm&bbox=-170,5,-50,85&limit=100` or `/v1/emissions?source=epa-nei&year=2023&medium=air&limit=100`. Facility filters are `source,q,id,country,bbox,limit,offset`; emissions filters are `source,facilityId,year,pollutant,medium,limit,offset`. Source filters are `osm,npri,epa-nei`. Default limit is 100, range 1-500; offset 0-1000000. Unknown/duplicate parameters are rejected; values are bounded to 200 characters. Responses have `total,limit,offset,nextOffset,sources,records,warnings`.

NPRI job results use annual `amount/units`, pollutant/media, reported estimation basis, preliminary/missing states and hashes. NEI job results use `quantity/unit`, `reportingYear`, pollutant and facility; the browse API additionally aliases them to `amount/units/year/facilityId`. Preserve raw units such as `LB`/`TON`; no cross-unit or cross-pollutant totals are supplied. Summary NEI measurement methods are `not_supplied_in_summary`. These are reported/inventory releases, not permit limits or ambient concentration observations.

OSM elements retain map IDs; ways/relations use bounding-box centers. Country filtering uses sparse explicit source tags, not reverse geocoding. NPRI/NEI NAICS 518210 matches are sector candidates, not independently confirmed data centers. Source IDs are not automatically joined by name/proximity. An analysis needing a shared facility identity must implement and validate that linkage.

### User-supplied ground evidence

`ground-evidence` accepts records with domain `water-quality|noise|agriculture|vegetation`, variable/unit, finite value or null, UTC timestamp with seconds and `Z`, WGS84 point, station ID and provenance `{sourceUrl,recordId,method:measured|reported|estimated}`. Optional bounded fields include record-level `facilityId` and nested `provenance.qualityFlag` / `provenance.notes`. Source URLs must be HTTPS references without embedded credentials and are never fetched.

Noise supports LAeq/Lden/Lnight/LAmax/LCpeak. LAeq requires positive duration; Lden/Lnight requires a source-period/weighting description. Water-quality records can retain qualifiers and detection limits without substitution. The importer deep-clones separate records and returns `evidence:user-supplied`, `verification.status:not_independently_verified`. It performs no dB averaging, unit conversion, source verification, yield inference or facility attribution. No acoustic/crop-yield dataset ships with it; vegetation proxies remain distinct from actual yields.

## Source-specific normalization for Part 2

There is **no universal result schema**. Branch on request kind/source and retain each source definition before constructing a Part 2 analysis dataset.

| Result family | Series/value path | Cadence / important units |
| --- | --- | --- |
| POWER global series | `metrics[].series[]`, metric `variable/units` | Monthly UTC; T2M source `C`, PRECTOTCORR `mm/day` rate, RH2M `%`, WS2M `m/s` |
| POWER REST point | `variables[].series[]`, variable `id/unit` | Monthly LST per source header/warnings; model-derived |
| CAMS | `variables[].series[]`, variable `id/unit` | Hourly UTC output; source units retained, typically μg/m³; approximately 45 km model scale |
| ERA5 / HighResMIP | `models[].metrics[].series[]`, metric `id/units` | Daily UTC; °C, mm, modeled moisture m³/m³; scenario identity must remain attached |
| NPRI / NEI | Separate annual release/inventory records | Source mass/unit, pollutant, medium and inventory year; missing is unknown |
| USGS | `records[]` by parameter/time-series/statistic/unit | Irregular station observations, source-specific units/qualifiers/censoring |
| Ground import | Supplied `records[]` | Source-declared cadence/units; independently unverified |

Never silently fill nulls with zero, convert precipitation rate to a monthly total without a declared transformation, average dB arithmetically or add overlapping PM categories/all-media totals. Keep source point/grid/datum and requested region distinct. Reported model coordinates may echo a request; a detailed globe does not establish building-scale scientific resolution.

## Cache, provenance and persistence

| Local implementation path/key | Contents |
| --- | --- |
| `data/raw/environment/power-grid/` | Original compressed Zarr metadata/chunks and verified inventory |
| `data/raw/environment/<rawRecord>.json` | Source payload/extraction records retained by hash |
| `data/processed/environment/` | Catalog, acquisition, source snapshots, derived caches, ground evidence and `run-<id>.json` results |
| `data/runs/environment/<id>.json` | Persisted submitted request/lifecycle/stage/errors |
| `facilities-osm`, `facilities-region-<hash>` | Global OSM alias and separate regional snapshots |
| `emissions-npri`, `emissions-npri-scope-<hash>` | Broader NPRI alias plus retained acquisition scopes |
| `emissions-epa-nei[-year-<year>|-state-<state>-<year>]` | Latest-year alias and explicit national/state/year snapshots |

`EnvironmentStore.key(value)` is SHA-256 of `JSON.stringify(value)`. Most extended results expose `rawRecord/rawSha256` for local lookup. That hash describes serialized parsed payloads, not the pretty-printed disk file or necessarily original HTTP bytes. Some sources also expose `sourceDocuments` with source-document hashes; compressed POWER chunks have their own checksums. Record exactly which hash/version an analysis consumed. There is no raw-file HTTP endpoint.

The library combines cached scopes **within each source** by facility-year using newest retrievals. A newer NPRI no-substance report removes older release rows. EPA national/state scopes retain explicit coverage and regional-only years. OSM regional snapshots do not replace the global map. This reconciliation does not establish a cross-source facility match.

Derived results generally have a 24-hour TTL. POWER keys include request plus source inventory/revision. Other adapters use request/adapter-aware keys; the default air-quality period includes the current day in its key. ERA5/climate source caching lets agriculture reuse matching inputs. Explicit facility/emissions sync refreshes snapshots. Ground imports do not claim a remote-verification cache hit.

JSON persistence uses temporary files and rename. Completed jobs/results survive restart; saved queued/running jobs become failed `INTERRUPTED`. Submit a new POWER sync to reuse verified chunks. Failed initial writes do not accept work. If terminal persistence also fails, `RUN_PERSISTENCE_FAILED` is available in memory only; restart uses the last durable record.

Local limits are one active worker, 16 waiting jobs, 1,000 retained records, 64 event sockets and 64 KiB bodies. Default POWER raw-cache budget is 768 MiB (64-1024 allowed); other sources/results/jobs add disk usage. No automatic old-run eviction endpoint exists. The Python worker defaults to 20 minutes; CLI waits are bounded to 30 minutes per job.

Open-Meteo quotas are weighted by range/variables/models and shared by IP. Large uncached land/climate requests are spaced by an abortable background cooldown; `source-rate-cooldown` is a stage, not an ETA. `429` remains an explicit failure with provider Retry-After when supplied; retry later and reuse completed work. Public Open-Meteo service is non-commercial-only; preserve CC BY/model attribution. OSM carries ODbL database/attribution obligations. No credentials are configured for the implemented public requests.

## Concrete Part 2 entry points

The normal consumer entry is the validated HTTP job API, which preserves caching, quotas, persistence and provenance. Direct adapter calls bypass portions of that orchestration. For code integration, the implementation exports:

```ts
// Imports are relative to this repository root; adapters are included in this PR.
import type { EnvironmentRequest, EnvironmentRun } from "./packages/contracts/src/environment.ts";
import { validateEnvironmentRequest } from "./packages/contracts/src/environment.ts";
import { EnvironmentStore } from "./apps/api/src/environment/store.ts";
import { environmentExecutor, runGridWorker } from "./apps/api/src/environment/service.ts";
import { fetchPowerSeries } from "./apps/api/src/environment/power.ts";
import { fetchAirQuality } from "./apps/api/src/environment/air-quality.ts";
import { fetchWaterQuality } from "./apps/api/src/environment/water-quality.ts";
import { fetchLandClimate } from "./apps/api/src/environment/land-climate.ts";
import { agricultureIndicators, compareAgriculture } from "./apps/api/src/environment/agriculture.ts";
import { fetchFacilities } from "./apps/api/src/environment/facilities.ts";
import { fetchNpriEmissions } from "./apps/api/src/environment/emissions.ts";
import { fetchUsEmissions } from "./apps/api/src/environment/us-emissions.ts";
import { queryLibrary, sourceSnapshots } from "./apps/api/src/environment/library.ts";
import { validateGroundEvidence, normalizeGroundEvidence } from "./apps/api/src/environment/ground-evidence.ts";
```

`environmentExecutor(store)` returns `(request, signal, report) => Promise<unknown>`; `report(progress,stage,details?)` updates jobs. `fetchLandClimate(query,{climate:true})` selects the scenario path; otherwise it selects ERA5. `compareAgriculture(baseline,future,settings)` requires matching climate-simulation evidence/models. Adapters expose typed results and injectable `fetchImpl`/abort options for meaningful fixtures.

`runGridWorker` is hardcoded to `services/data/power_grid.py`, not a generic model runner. It writes one JSON stdin request and consumes progress JSON lines plus one `{type:"result",result:...}` message. A Part 2 scientific worker needs a new bridge or an explicit refactor; do not send analysis payloads to this grid helper or the inactive accounting worker.

## Proposed Part 2 integration — not active Node API operations

1. Evaluate/reuse main's existing statistical routines and expose appropriate historical trend magnitude/significance through a declared Node environmental analysis contract for variable/region/period. Define seasonality, aggregation, missing-data thresholds, serial correlation, multiple testing and rate units. Operational model changes and regulatory-reporting changes require comparability checks.
2. Define a versioned analysis input referencing completed run IDs, source/raw hashes, variable/unit, evidence, geography/grid/datum, temporal support, quality/censoring rules and declared transformations. Preserve the acquired input rather than silently refetching during a reproducible run.
3. Define output with method/model version, parameters, source references, result units, actual coverage, uncertainty, diagnostics and unavailable metrics. Analysis cache keys must include input hashes, model/method version and parameters, not only a location/date.
4. Add an explicit request type and validator in `environment.ts`, dispatch in `environmentExecutor`, scientific worker bridge and meaningful numerical/held-out checks. Reuse `EnvironmentJobs` lifecycle/persistence and HTTP/WS delivery. Names such as `trend-analysis` or `impact-scenario` are **illustrative future names and are currently rejected by the Node environmental API as request kinds**.
5. Introduce calibrated air-quality, hydrological, acoustic or crop models only when inputs, scale, supported horizon and validation exist. Facility linkage/attribution needs verified operating history, emissions/withdrawals and comparison areas; nearby trends alone are insufficient.

Part 2 readiness means a reproducible dataset with units, timestamps, null/quality handling and provenance—not automatic readiness to predict a facility's future effects. Crop work additionally needs identity/phenology, soil/management observations and observed yields; vegetation indices are not yield measurements.

## Remaining access/model gaps and Unreal boundary

In the Node environmental implementation, curated CMR discovery covers MERRA-2, IMERG, OMI, MODIS vegetation/surface-temperature and GLDAS families, with version/access metadata. Those records are not downloaded observations. Earthdata Login is not configured and would not itself implement missing extraction adapters. Its public ORNL NDVI probes on 2026-11-14 returned 503 / band-metadata timeout; no NDVI adapter or numeric vegetation acquisition is claimed for that Node environmental pipeline. Main's separate GIBS-derived vegetation work is described above. GISTEMP probes timed out; helper code is not acquired evidence.

Within this Node environmental contract, statistical trend jobs, validated facility effects, pollutant transport/deposition, comprehensive water chemistry, acoustic impacts, calibrated yields/suitability and scenarios to 2100 remain unavailable. It includes no compiled Unreal client for these `/v1` routes; main's engine/web work remains a separate integration target. A future connector can browse source IDs, submit supported jobs, follow status and render cached results at their supplied cadence. The Node environmental API supplies no layer URLs or globe stream; main's existing WMTS layers use a different contract. Terrain/facility edits affect these numerical results only after a supported model accepts them.

## Primary resource references

- [Official challenge resources](https://www.spaceappschallenge.org/2026/challenges/earth-system-trend-detective/?tab=resources): the 13 listed challenge links remain the core research catalog; supplementary adapters below must not be relabeled as challenge-listed resources.
- [NASA POWER AWS access](https://power.larc.nasa.gov/docs/services/aws/) and [monthly API](https://power.larc.nasa.gov/docs/services/api/temporal/monthly/).
- [OpenStreetMap attribution](https://www.openstreetmap.org/copyright) and [Overpass API](https://dev.overpass-api.de/overpass-doc/en/).
- [NPRI interpretation](https://www.canada.ca/en/environment-climate-change/services/national-pollutant-release-inventory/using-interpreting-data.html), [EPA NEI](https://www.epa.gov/air-emissions-inventories/national-emissions-inventory-nei) and [Envirofacts API](https://www.epa.gov/enviro/envirofacts-data-service-api).
- [CAMS air-quality API](https://open-meteo.com/en/docs/air-quality-api), [ERA5 access](https://open-meteo.com/en/docs/historical-weather-api), [HighResMIP access](https://open-meteo.com/en/docs/climate-api), [Open-Meteo terms](https://open-meteo.com/en/terms) and [data licensing](https://open-meteo.com/en/licence).
- [Modern USGS API](https://api.waterdata.usgs.gov/docs/ogcapi/) and [provisional-data statement](https://waterdata.usgs.gov/provisional-data-statement/).
- [ORNL terrestrial-ecology service](https://modis.ornl.gov/data/modis_webservice.html): documented access path, with the local probe failure recorded above.
