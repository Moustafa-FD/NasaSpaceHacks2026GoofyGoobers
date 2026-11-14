# Local environmental API and acquisition contracts

The active local API serves environmental discovery, facility/emissions snapshots, historical data, climate simulations, agricultural exposure screening and unverified ground-record imports. It binds to `http://127.0.0.1:3000` by default. Requests are asynchronous jobs with persisted local records/results. There is no public authentication or compiled Unreal connector; a remote deployment requires deliberately configured HTTPS/WSS and access controls.

The canonical request/run types and validator are in [environment.ts](../packages/contracts/src/environment.ts). Legacy accounting request bodies are not accepted by the active API.

## Endpoints

| Method | Path | Implemented behavior |
| --- | --- | --- |
| GET | `/health` | `{"status":"ok","schemaVersion":"1.0","mode":"environmental","persistence":"local-files"}` |
| GET | `/v1/domains` | Environmental capability registry; live adapters are distinguished from metadata-only/authentication-required and planned work |
| GET | `/v1/sources` | Access matrix, source definitions, documentation and observed access limitations |
| GET | `/v1/catalog` | Cached curated CMR metadata, or `not_synced` with empty records before discovery |
| GET | `/v1/inventory` | Actual cache bytes, POWER inventory/acquisition, CMR metadata, `datasets` snapshot states and `geographicPriority: [CA,US]` |
| GET | `/v1/facilities` | Browse/filter saved facility snapshots, with source identities preserved |
| GET | `/v1/emissions` | Browse/filter saved official annual release/inventory records |
| POST | `/v1/runs` | Validate a supported environmental request and return `202` with a run ID and paths |
| GET | `/v1/runs/{id}` | Authoritative current run state, request, stage/details and errors; see disk-failure exception below |
| GET | `/v1/runs/{id}/results` | Completed result; `409` until the run completes or when it failed |
| WebSocket | `/v1/runs/{id}/events` | Immediate current `run.status` snapshot followed by status/progress changes |

No cancellation, pause/resume, login, arbitrary URL download, durable event replay or tile-serving endpoint is implemented. Acquisition resumes by submitting a new sync, which reuses verified cached chunks.

## Sources and current capabilities

| Source ID | Access and semantics |
| --- | --- |
| `power-grid` | Public NASA POWER MERRA-2-based monthly global Zarr. UTC time standard, native approximately 0.5-degree latitude x 0.625-degree longitude. Sync once, then query verified cached chunks. |
| `power-point` | Public NASA POWER monthly REST point query. LST time standard; retained source metadata defines the reported point/units. It is a point retrieval, not a global numeric download. |
| CMR catalog | Public metadata discovery for six curated environmental collection families and returned versions. Records are `metadata_only`; source bounds do not mean observations are local. |
| Giovanni / AppEEARS | Source metadata/discovery only in this implementation. Extraction needs authentication plus an implemented adapter; configuring Earthdata Login alone does not enable a missing adapter. |
| GISTEMP | Optional helper code exists, but its host timed out during setup. No downloaded GISTEMP observations are claimed. |
| Vegetation / ORNL | Public NDVI access probe returned 503 and band metadata timed out on 2026-11-14. No numeric NDVI adapter/acquisition; collection discovery and supplied evidence remain separate. |
| `osm` | Public incomplete OSM source-element snapshot; ODbL attribution/database obligations. |
| `npri` / `epa-nei` | Official Canadian releases / US emissions inventory estimates for sector candidates; source IDs stay distinct. |
| `cams` / `era5` / `highresmip` | Open-Meteo public non-commercial model/history/climate paths; source-specific cadence, limits and attribution. |
| `usgs` | Public modern USGS station observations for selected water-quality indicators; source qualifiers/approval/method category and actual station coverage retained. |
| `ground-evidence` | Local structurally validated user import; no independent source verification or shipped measurements. |

The table includes registry IDs. Use each operation's request shape below; not every registry ID is a valid `source` request field.

Supported POWER variable IDs are `T2M`, `PRECTOTCORR`, `RH2M` and `WS2M`. They are model-derived meteorological quantities: temperature, corrected precipitation rate, relative humidity and wind speed. They are not pollutant concentrations, water chemistry or noise measurements. Units and temporal aggregation come from the source metadata.

Global grids use UTC; REST points use LST. Do not silently combine those series as if their temporal definitions were identical. Source coverage and downloaded coverage are separate facts. The store can allocate future time slots containing only missing values; availability is established from finite source data for historical/current months, not the final allocated time coordinate.

## POWER request fields and validation

Every operation requires `schemaVersion: "1.0"` and `kind`. Unknown fields are rejected. This table describes the original POWER `sync`/`series`/`grid` operations; additional kinds have separate fields below.

| Field | Meaning and constraints |
| --- | --- |
| `kind` | `sync`, `series` or `grid` |
| `source` | `power-grid` or `power-point`; required for series/grid, forbidden for sync |
| `variables` | Optional for sync/series, otherwise 1-4 unique supported IDs; grid requires exactly one |
| `start`, `end` | Series requires ordered `YYYY-MM`; historical dates from 1981-01 through the current UTC month |
| `date` | Grid requires one historical `YYYY-MM`; forbidden for series/sync |
| `point` | `{latitude, longitude}` within WGS84 bounds; permitted for series only |
| `bbox` | `[west,south,east,north]` within WGS84 bounds, ordered; series only, no antimeridian crossing |
| `maxCacheMiB` | Sync only; integer 64-1024, default 768 |
| `refreshCatalog` | Sync only; boolean, refreshes CMR metadata when true |

`power-point` requires a point and does not accept a bbox. A `power-grid` series requires either a point or bbox, never both. Use `[-180,-90,180,90]` for a global area-mean series. A grid request returns the complete native global frame and accepts no point/bbox/start/end/sync-only fields.

### 1. Sync global selected-variable history

Use [environment-sync.json](../data/examples/environment-sync.json):

```json
{
  "schemaVersion": "1.0",
  "kind": "sync",
  "variables": ["T2M", "PRECTOTCORR", "RH2M", "WS2M"],
  "maxCacheMiB": 768,
  "refreshCatalog": true
}
```

Sync discovers/caches the curated CMR collection metadata, then acquires all source spatial chunks for the selected POWER variables. Each spatial chunk contains its encoded time dimension, so retrieving recent months cannot avoid historical bytes in that same chunk. Progress reports completed chunks and actual downloaded bytes; rerunning verifies/reuses compatible cached files and resumes missing work.

A complete sync means the selected variables' expected spatial chunks were acquired, with their complete encoded time axis. It does **not** mean that all NASA products are downloaded, every encoded month has valid values, or every grid cell/month is valid. Inspect per-variable `firstValidDate`, `lastValidDate`, `validMonthCount`, chunk counts and source definitions. A budget/network failure retains partial cache state instead of fabricating completion.

### 2. Read a cached point or area series

[environment-series.json](../data/examples/environment-series.json) requests global monthly means:

```json
{
  "schemaVersion": "1.0",
  "kind": "series",
  "source": "power-grid",
  "variables": ["T2M", "PRECTOTCORR"],
  "start": "2015-01",
  "end": "2026-09",
  "bbox": [-180, -90, 180, 90]
}
```

For a nearest-native-cell series replace the bbox with `"point": {"latitude": 43.65, "longitude": -79.38}`. For REST point acquisition use `source: "power-point"` and a point. Example coordinates are request illustrations, not claims about a facility or personal location.

Cached global queries require all intersecting chunks to be present and verified; they do not average only whichever tiles happened to download. A too-small bbox containing no native grid-cell centers returns an explicit failure. A point selects the nearest source grid cell and reports its source coordinates. Area means use spherical latitude-band cell weights over valid cells whose centers fall within the bbox, not precise polygon-edge fractional clipping.

The grid-series result includes source/version, UTC standard, native resolution, selection and `metrics`. Each metric preserves `variable`, `label`, `units`, definition, temporal/spatial aggregation and `series` samples containing `date`, `value`, `validCellCount`, `totalCellCount` and `coverageFraction`. Missing values remain `null`. Uncertainty is `not_quantified`; this ingestion service does not estimate observational/model error or perform significance tests.

### 3. Read one global native frame

```json
{
  "schemaVersion": "1.0",
  "kind": "grid",
  "source": "power-grid",
  "variables": ["T2M"],
  "date": "2025-12"
}
```

The result includes a `grid` object with variable/date/units, latitude and longitude coordinates, `shape`, flattened `values`, and ordering described as latitude-major rows with longitude-minor columns. Missing samples are `null`. Use metadata/inventory to choose a genuinely available month; a requested date does not prove source data exists. The endpoint returns JSON, not a rendered heatmap, tile server or higher-resolution dataset.

## Additional operations and source semantics

Coverage is global where supported; Canada and USA investigations are the current priority. These sources have different cadences, evidence and geographic coverage. A point query is not a global download, a facility inventory is not an emissions measurement, and climate simulations are not observed weather.

| `kind` | Required fields and bounds | Result/evidence |
| --- | --- | --- |
| `facilities-sync` | Optional `bbox: [west,south,east,north]`; omit for the bounded global OSM query | OSM data-center source elements, counts, timestamp, tags, coordinates and ODbL attribution; incomplete volunteered snapshot |
| `emissions-sync`, `source: npri` | Optional `startYear`, `endYear` (ordered historical NPRI years), `maxReports` 1-100, default 100; omitted years use source availability | Canadian NAICS 518210 facility-year reports and pollutant/media releases; report methods, source units, preliminary/missing states, hashes and truncation |
| `emissions-sync`, `source: epa-nei` | Optional inventory `year` in 2008/2011/2014/2017/2020/2023, default 2023; optional two-letter US `state` | US NAICS 518210 annual air-emissions inventory estimates; raw units and source identity retained |
| `air-quality` | `point`; optional paired `start`/`end` daily dates, 1-31 completed UTC days from 2022-08-01 through yesterday; omit both for last 7 completed days; optional 1-5 unique pollutant IDs | CAMS global modeled near-surface concentrations, hourly output and source units; numeric availability varies |
| `land-water` | `point`, ordered daily `start`/`end` from 1940-01-01 through at least 5 days ago; bounded to about 2 years per request | ERA5 daily model/reanalysis temperature, precipitation, reference ET0 and soil moisture by depth |
| `water-quality` | `stationId: USGS-` followed by 8-15 digits, ordered daily `start`/`end` within 1900-01-01..today, at most 31 inclusive days; optional unique `parameters` from the five codes below | Real USGS continuous station records with units, source times, approval/qualifier/method metadata, missing/censored values and coverage |
| `climate` | `point`, ordered daily `start`/`end` within 1950-01-01..2050-01-01, about 10 years per request; optional one/two supported models | HighResMIP climate-scenario daily series, model identity, spatial scale, forcing description and units |
| `agriculture` | `point`, `baseline`/`future` date objects, explicit growing months/thresholds, optional supported models; complete calendar years within 1950-2049, at most 10 each; future starts after today and follows baseline | Conditional climate-exposure comparison; no yield forecast, suitability rating or facility attribution |
| `ground-evidence` | `records`, 1-100, subject to the common 64 KiB HTTP body limit and detailed rules below | Structurally validated user-supplied evidence; not independently verified |

Daily intervals are inclusive. The land/water validator allows an end-minus-start difference up to 731 days, and climate allows up to 3660 days; split longer requests. Supported climate models are `EC_Earth3P_HR` and `MRI_AGCM3_2_S`, both selected when omitted. There is no SSP/pathway selector. HighResMIP forcing is described by the provider as close to RCP8.5; this adapter does not extrapolate to 2100.

### Facility and official-emissions acquisition

```json
{"schemaVersion":"1.0","kind":"facilities-sync"}
```

```json
{"schemaVersion":"1.0","kind":"emissions-sync","source":"npri","maxReports":100}
```

```json
{"schemaVersion":"1.0","kind":"emissions-sync","source":"epa-nei","year":2023,"state":"VA"}
```

OSM nodes/ways/relations retain their own IDs. Multiple elements can represent one campus/building; country filters/counts use explicit country tags only. Regional OSM syncs are saved separately and do not replace an acquired global registry. OSM does not establish operating status, capacity, opening dates or emissions.

NPRI/EPA candidates match NAICS 518210, which includes related services as well as data-center activities. Candidates are not independently confirmed data centers. Government source IDs are not automatically joined to OSM or imported station/facility IDs by proximity/name. An annual mass release is not an ambient concentration, exposure or attributable environmental effect. Retain reporting/estimation methods where available; NEI methods are not assumed when absent. Do not sum overlapping PM categories or all-media totals together with component media. Missing amounts/reports remain unknown, never zero.

### Historical modeled air quality

```json
{"schemaVersion":"1.0","kind":"air-quality","point":{"latitude":43.65,"longitude":-79.38},"start":"2026-11-01","end":"2026-11-07","variables":["pm2_5","pm10","nitrogen_dioxide","ozone","sulphur_dioxide"]}
```

Uses a fixed Open-Meteo CAMS-global endpoint; no key, arbitrary source URL or forecast request. Results retain requested/reported points, native approximately 0.4-degree scale, source/output cadence, UTC timestamps, units, nulls, valid/missing counts and first/last finite samples. Hourly output is not independent hourly measurement at every point. The archive is operational-model output and may change model versions; it is not a homogeneous reanalysis or a ground monitor. August 2022 source bounds do not guarantee numeric values on every day/cell.

### Daily land/water and climate context

```json
{"schemaVersion":"1.0","kind":"land-water","point":{"latitude":43.65,"longitude":-79.38},"start":"2024-01-01","end":"2024-12-31"}
```

```json
{"schemaVersion":"1.0","kind":"climate","point":{"latitude":43.65,"longitude":-79.38},"start":"2035-01-01","end":"2044-12-31","models":["EC_Earth3P_HR","MRI_AGCM3_2_S"]}
```

Both return daily mean/minimum/maximum air temperature, precipitation and reference ET0. ERA5 includes modeled soil moisture at 0-7, 7-28 and 28-100 cm, on an approximately 0.25-degree grid. Climate outputs include modeled 0-10 cm soil moisture; provider downscaling is approximately 10 km, with model-native scales approximately 20-29 km. Depths and grids must remain distinct.

The normalized result has `models: [{model, metrics: [{id,sourceVariable,units,series:[{date,value}],validDays,missingDays}]}]`, requested/source points, source URLs/hashes, time standard, scenario, license and warnings. Missing values remain null. Rainfall minus reference ET0 is climatic balance, not irrigation demand, water scarcity, withdrawals, river supply or water quality. Future simulation dates are not forecasts for particular days; two model results are sensitivity comparisons, not confidence intervals.

### Real station water-quality indicators

```json
{"schemaVersion":"1.0","kind":"water-quality","stationId":"USGS-01646500","start":"2026-11-01","end":"2026-11-01","parameters":["00010","00095","00400","00300","63680"]}
```

Uses the modern anonymous USGS v1 continuous API, not the legacy Water Quality Portal. Supported codes are water temperature `00010`, specific conductance `00095`, pH `00400`, dissolved oxygen `00300` and turbidity `63680`; all five are requested by default. Station/parameter availability determines actual history, with no universal start date inferred from request validation. Discharge `00060` is not accepted as a substitute for water quality.

Results contain `evidence: ground-observation`, station metadata and EPSG:4326 geometry/original datum, requested period, per-parameter records/pagination states, raw/source-document hashes and individual records. Records preserve source timestamps and normalized UTC timestamps, parameter/time-series/statistic IDs, `rawValue`, numeric or null `value`, source `unit`, `approvalStatus`, `qualifier`, `methodCategory`, and modification time. Units are retained exactly as returned; distinct units/time series/statistics are not automatically merged. Provisional or estimated qualifiers remain visible and do not establish validated measurements.

Censored strings preserve their operator/bound with null numeric value. Bounds are not relabeled laboratory detection limits, and absent full analytical methods/detection-limit metadata remains unspecified. No averaging, chemistry inference, facility matching or causal attribution occurs.

Requests are bounded internally to 20,000 records and a default 32 MiB total download budget (4 MiB per document), with fixed-origin sequential pagination. A cap leaves incomplete/unknown parameter coverage explicit. `complete` means requested pagination was exhausted, not continuous monitoring, every parameter available, complete water chemistry, potability or regional uniformity. The current day can be partial. Anonymous service limits apply; API keys can raise quotas, but none is configured or sent by this adapter.

### Agricultural climate-exposure comparison

```json
{
  "schemaVersion":"1.0","kind":"agriculture",
  "point":{"latitude":43.65,"longitude":-79.38},
  "baseline":{"start":"2015-01-01","end":"2024-12-31"},
  "future":{"start":"2035-01-01","end":"2044-12-31"},
  "models":["EC_Earth3P_HR","MRI_AGCM3_2_S"],
  "growingMonths":[5,6,7,8,9],
  "baseTemperatureC":10,"heatThresholdC":30,"dryDayThresholdMm":1
}
```

These months/thresholds are example screening assumptions, not universal crop requirements. `growingMonths` contains 1-12 unique calendar months. Base temperature must be finite -10..40 C, heat threshold greater than base and at most 60 C, and dry-day threshold 0..20 mm. Comparisons use matching climate simulations for baseline/future, not measured historical weather against an unmatched future model.

For complete selected-month seasons, each model returns mean temperature, growing degree days `sum(max(0, meanTemperature-base))`, maximum-temperature days above the heat threshold, minimum-temperature days below 0 C, rainfall days below the dry threshold, precipitation/reference ET0 totals, their difference and mean surface soil moisture. Missing samples or incomplete selected seasons produce null for affected metrics. Means/change are reported per season/model without statistical significance or probabilistic confidence; short periods can be dominated by natural variability. Calendar-year grouping does not model cross-year crop phenology.

The output explicitly lists crop-yield prediction, data-center-attributable crop effects and pollution-crop damage as unavailable. Crop identity, phenology, soil/management data, exposure-response/crop models and observed-yield validation are not supplied by this screening calculation.

### Ground water-quality, noise, agriculture and vegetation records

```json
{
  "schemaVersion":"1.0","kind":"ground-evidence",
  "records":[{
    "domain":"noise","variable":"LAeq","unit":"dB(A)","value":null,
    "date":"2026-11-01T12:00:00Z","point":{"latitude":43.65,"longitude":-79.38},
    "stationId":"example-station","durationSeconds":3600,
    "provenance":{"sourceUrl":"https://example.org/schema-example-not-a-measurement","recordId":"example-record","method":"estimated","notes":"Schema example only; no real measurement is supplied."}
  }]
}
```

Each record requires `domain` (`water-quality`, `noise`, `agriculture`, `vegetation`), nonblank `variable` (max 120 characters), `unit` (80), finite numeric or null `value`, a real UTC timestamp with seconds and `Z`, WGS84 `point`, `stationId` (160), and `provenance`. Provenance requires HTTPS `sourceUrl` without credentials (2048), `recordId` (200), and `method: measured|reported|estimated`; optional `qualityFlag` (120) and `notes` (1000). Optional `facilityId` (160) remains a user assertion. Unknown fields are rejected at all levels.

Noise metrics are `LAeq`, `Lden`, `Lnight`, `LAmax`, `LCpeak`; LAeq requires positive finite `durationSeconds` up to 366 days. Lden/Lnight requires a nonblank `period` describing the source period/weighting (max 500 characters); other noise records may retain it. Water-quality records alone can retain `qualifiers` (1-10 nonblank labels, max 120 each) and finite nonnegative `detectionLimit` in supplied units. Censored values are not substituted. Acoustic duration/period fields are noise-only.

The importer does not fetch source URLs, independently verify/calibrate measurements, merge facility identities, average dB, convert units, substitute nulls or infer crop yields from vegetation proxies. Output explicitly states `evidence: user-supplied` and `verification.status: not_independently_verified`; each record and source qualifier remains separate.

### Browse locally saved source snapshots

`GET /v1/facilities` accepts `id`, `q`, ordered CSV `bbox=west,south,east,north`, two-letter `country`, `source=osm|npri|epa-nei`, `limit` and `offset`. `GET /v1/emissions` accepts `facilityId`, `source`, `year`, `pollutant`, `medium`, `limit` and `offset`. Default page size is 100, permitted `limit` is 1-500 and `offset` is 0-1000000; query values are bounded to 200 characters. Unknown/duplicate parameters are rejected with `400 INVALID_LIBRARY_QUERY`. Responses contain `total`, `limit`, `offset`, `nextOffset`, `sources`, `records` and warnings. OSM country selection uses explicit source tags, not reverse geocoding. Source presence/counts are snapshot facts; incomplete/missing countries or releases do not mean no facility/emissions. Whole-US EPA inventory years are combined for browsing with each record's original year and `reportingYears` in inventory; no continuous annual interpolation occurs. NPRI cached scopes and EPA national/state/year snapshots are combined by source facility-year identity, using the newest retrieved report/records; a newer NPRI report with no reportable substances removes older release rows. EPA record identities are deduplicated, and coverage distinguishes nationwide from regional-only inventory years. Regional OSM snapshots remain separate from the global map registry. EPA facility metadata follows the latest acquired inventory record for that source ID. There is no `omitMissing` filter; preserve missing values.

### Bounded expansion command

With the API running, `npm run data:expand` submits global OSM, bounded available NPRI sector history, the six supported whole-US EPA inventory years Canada/USA point examples (recent CAMS, 2024-2025 ERA5, 2040-2049 climate and a baseline/future agricultural comparison), and a bounded real USGS Potomac station example. It saves an ignored `data/runs/environment/expansion-report.json`, reuses completed matching run IDs, rejects duplicate active work and records failures. Use `npm run data:expand -- --refresh` for deliberate resubmission. A partial expansion is not overall completion: failures remain recorded and completed matching jobs are reused on a later rerun. This is not a global download of every environmental field and does not supply acoustic or crop-yield measurements. Real USGS station observations are retrieved separately from user-supplied ground imports.

After successful expansion, `npm run data:verify-expanded` checks completed saved jobs, source filters/pagination and inventory coverage, then writes ignored `data/runs/environment/expanded-verification.json`. It is an optional live API check, outside offline `npm run check`, and does not validate causal or predictive skill.

## Supplementary-source terms

Open-Meteo public air/history/climate access is non-commercial-only and rate-limited; data require CC BY attribution to the provider/model producers. Long ranges, variables and model counts consume weighted quotas shared by IP; a small number of HTTP calls can still hit `429`. Source `Retry-After` is included when returned. Later retry should reuse completed work rather than repeatedly submit requests. The backend may report `source-rate-cooldown` during an abortable background pause between large source requests; this is not an estimate of scientific completion time. Preserve license/source warnings in clients. OSM locations require ODbL attribution/database obligations. These supplementary sources do not replace or relabel the 13 official challenge links.

## Submission, status and notifications

Set `Content-Type: application/json` and POST to `/v1/runs`. Successful submission returns immediately:

```json
{
  "id": "<run-id>",
  "status": "queued",
  "statusUrl": "/v1/runs/<run-id>",
  "resultUrl": "/v1/runs/<run-id>/results",
  "eventsUrl": "/v1/runs/<run-id>/events"
}
```

Resolve the returned paths against the configured API origin. States are `queued`, `running`, `completed` and `failed`. A run contains `id`, `status`, `progress`, `stage`, `createdAt`, `updatedAt` and the submitted **`request`**. It may include progress `details`, terminal `error: {code,message}` or a completed `resultUrl`. Earlier accounting examples using `scenario` are not this contract.

Connect to `ws://127.0.0.1:3000` plus the returned events path. For a remote HTTPS backend use WSS. The server sends a latest snapshot on connection, even if work finished before subscription:

```json
{
  "type": "run.status",
  "run": {
    "id": "<run-id>",
    "status": "running",
    "progress": 10,
    "stage": "acquiring-global-history",
    "createdAt": "<ISO-8601 timestamp>",
    "updatedAt": "<ISO-8601 timestamp>",
    "request": {"schemaVersion":"1.0","kind":"sync"}
  }
}
```

The same envelope carries later changes. Progress reflects the acquisition lifecycle/chunk counts where available; it is not a prediction of remaining wall-clock time. Incoming WebSocket controls are unsupported and close the read-only stream. After reconnect, fetch HTTP status; intermediate events are not durably replayed. Polling the status URL is a valid simpler client.

On completion fetch the result once and cache it. On failure display the recorded reason; do not keep waiting forever or convert failure to a numeric value. Timeline movement should read saved series. Applying changed acquisition/analysis inputs starts another job.

## Persistence, cache and limits

| Local location | Contents |
| --- | --- |
| `data/raw/environment/power-grid/` | Original compressed Zarr metadata/chunks and `inventory.json` with hashes/source headers/coverage |
| `data/raw/environment/` | Retained source responses/environment-relevant extraction records, referenced by source hashes/raw-record keys |
| `data/processed/environment/` | CMR/global summaries, facility/emissions snapshots, imported-evidence records, derived caches and `run-<id>.json` results |
| `data/runs/environment/` | Persisted job records and ignored live-verification/expansion reports |

Whole-US EPA year snapshots use `emissions-epa-nei-year-<year>` and retain a latest-year alias; state snapshots use separate state/year keys. OSM bbox snapshots have separate region keys, and NPRI has its own source snapshot. The browse union retains explicit cached-scope provenance and reconciles newer records within the same source/facility-year; it does not perform cross-source facility identity resolution.

Downloaded/generated data is ignored by Git. Completed jobs/results survive server restart. Previously queued/running jobs are marked `failed` with `error.code: "INTERRUPTED"`; they are not automatically relaunched. Submit a new sync to reuse verified chunks and continue acquisition.

POWER derived query-cache keys include the request and relevant global source inventory. Other compatible derived source queries use request/adapter-aware keys and a 24-hour TTL; explicit facility/emissions syncs refresh saved snapshots. Ground-evidence imports do not claim a remote-source verification/cache hit. The global sync stores `sourceRevision`; altered source/chunk inventory changes invalidate compatible derived results, and processed query entries have a 24-hour TTL. Re-sync deliberately to discover source updates; a cached derived result is not a guarantee that the remote source has not changed.

Local limits: one active worker, 16 waiting jobs, 1000 retained run records, 64 event sockets and 64 KiB request bodies. Sync's default compressed-cache budget is 768 MiB (request range 64-1024 MiB). This covers its raw global compressed cache/inventory, not total project disk usage; processed outputs, saved jobs and independent point responses can add storage. The data worker's default timeout is 20 minutes; `DATA_WORKER_TIMEOUT_MS` accepts a bounded override in implementation. The CLI waits at most 30 minutes, after which the saved status should be inspected before resubmission. There is no silent old-run eviction endpoint.

## Error handling

| HTTP status | Meaning |
| --- | --- |
| 400 | Malformed JSON/invalid request encoding, or `INVALID_LIBRARY_QUERY` for invalid browse filters |
| 413 | Request exceeds 64 KiB |
| 422 | Invalid environmental request; see `INVALID_ENVIRONMENT_REQUEST` details |
| 404 | Unknown route/run |
| 409 | Requested result is not completed, including a failed run |
| 503 | Waiting/retained-run capacity reached |
| 500 | Unexpected internal failure |

Source HTTP failures, missing/invalid cache chunks, unavailable dates, exceeded cache budget, invalid encodings and worker timeout/nonzero exit become failed jobs with `DATA_ACQUISITION_FAILED` and a diagnostic. Partial raw cache may remain resumable. A successful public CMR request is not evidence that Earthdata-protected observations were downloaded.

If the initial job-record write fails, submission returns an error instead of accepting/queuing a run. If a later failure cannot itself be saved, the current process still exposes a terminal failed state through HTTP/events with `error.code: "RUN_PERSISTENCE_FAILED"` and `details.persistence.status: "failed"`. Its message explicitly identifies the status as **memory only**. This terminal update may not survive restart; the last successfully saved record remains on disk, and an unfinished saved record becomes `INTERRUPTED` at startup. Repair the storage issue before submitting replacement work; do not infer durable completion from a failed write.

## Worker protocol

Node spawns `services/data/power_grid.py` asynchronously using an executable/argument array, never a shell command assembled from user fields. It selects `DATA_PYTHON_EXECUTABLE`, then the local `.venv`, then `PYTHON_EXECUTABLE`/`python`. `npm run data:setup` creates the virtual environment and installs [data requirements](../services/data/requirements.txt).

Node writes one UTF-8 JSON request to stdin. The data worker writes JSON-lines `progress` events and one final `{type:"result",result:...}` message to stdout; errors go to stderr with nonzero exit. This differs from the retained legacy accounting worker's single-manifest stdout protocol. Node persists lifecycle changes and results and exposes the common HTTP/WebSocket interface to clients.
