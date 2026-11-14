# Part 3 integration guide (web + Unreal)

Parts 1 and 2 are connected and tested; what remains is front-end plumbing and presentation. This page lists everything a front end can call or load, and where each piece belongs on screen. Visual clean-up items are tracked in issue #4.

## How the parts connect

```text
Part 1 (Node /v1 API, :3000)                       Part 2 (Python models)                     Part 3 (web / Unreal)
acquire: POWER, CAMS, ERA5, HighResMIP, USGS,  ──► trend-analysis    (runId / runIds / inline) ──► POST /v1/runs + WS events + results
         OSM facilities, NPRI/NEI emissions        plume-scenario    (site or any point)
                                                   climate-projection (any point, to 2100)
static products (no server needed) ─────────────────────────────────────────────────────────► data/fields, data/projections, data/plumes
```

- **One job API.** Part 2 models run as Part 1 job kinds (`trend-analysis`, `plume-scenario`, `climate-projection`). They share its validation, queue, persistence, caching and WebSocket progress.
- **Part 1 data feeds Part 2 directly.** `trend-analysis` reads completed `series` (POWER), `air-quality` (CAMS), `land-water` (ERA5), `climate` (HighResMIP) and `water-quality` (USGS) runs by ID. It stitches several runs in time (Part 1 caps request lengths), averages hourly data to daily, keeps censored values missing, and **refuses** to merge different evidence types or units.
- **Giovanni** series are downloaded by Part 2 (`services/models/trends/giovanni.py`) and sent to `trend-analysis` as inline series.
- **Browser access:** the API sends CORS headers to `http://localhost:8765`, `http://localhost:8080` (and the `127.0.0.1` forms) and `https://moustafa-fd.github.io`. Override with `API_CORS_ORIGINS`. The API listens on loopback only, so a hosted page can only use it on a machine that runs it; the **static products** below work everywhere.

## Job API (Part 1 + 2), base `http://127.0.0.1:3000`

| Step | Call |
| --- | --- |
| Capabilities | `GET /v1/domains` (`trend-analysis`, `air-dispersion-screening`, `climate-projection-2100` are `live_*`) |
| Submit | `POST /v1/runs` with a JSON body → `202 {id, statusUrl, resultUrl, eventsUrl}` |
| Progress | `ws://127.0.0.1:3000/v1/runs/{id}/events` (status snapshots); `GET /v1/runs/{id}` is authoritative |
| Result | `GET /v1/runs/{id}/results` once `status = completed` |

```js
// Browser or Node: submit a trend job and wait for the result
const api = "http://127.0.0.1:3000";
const { id } = await (await fetch(`${api}/v1/runs`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ schemaVersion: "1.0", kind: "trend-analysis", cadence: "annual",
    input: { series: { label: "OMI NO2", unit: "molec/cm2", points: [{ date: "2005-01", value: 1.2e16 } /* … */] } } }) })).json();
let run; do { await new Promise(r => setTimeout(r, 1000)); run = await (await fetch(`${api}/v1/runs/${id}`)).json(); } while (!["completed", "failed"].includes(run.status));
const result = run.status === "completed" ? await (await fetch(`${api}/v1/runs/${id}/results`)).json() : null;
```

Unreal: the same calls with the **HTTP** module (or HttpBlueprint) and **JsonBlueprintUtilities**; no CORS applies. Keep requests async so the render thread never waits.

### What to draw from each result

| Job | Show | Fields |
| --- | --- | --- |
| `trend-analysis` | Trend headline + chart band | `report.summary`, `report.sen.slopePerDecade`, `report.sen.ciPerDecade`, `report.mannKendall.pValue`, `report.direction`, `report.status` (`insufficient_data` → show `report.reasons`, never a number), `report.limitations`; with a control: `report.target`, `report.control`, `report.difference` |
| `plume-scenario` | Ground heat-map of relative dilution + receptor labels | `grid.values` (n×n, rows north→south, `grid.cellM`, `grid.halfWidthM`, units s/m³), `peak`, `receptors[]` (`chiOverQ`, and `concentrationUgM3` only if an emission was supplied), `assumptions`, `evidenceNote`. Use a log colour scale and label it "relative dilution" unless `emission` is present |
| `climate-projection` | Future-zone chart: baseline vs mid/late century per SSP, with min–max model whiskers | `metrics.meanTempC`, `metrics.hotDays35C`, `metrics.precipMmPerYear`, each with `historical_1995_2014` and `ssp245_2041_2060`, `ssp245_2081_2100`, `ssp585_…` → `value`/`changeFromHistorical` `{median, min, max, models}`; `evidenceNote` |

Evidence labels to keep visible: `statistical-analysis`, `scenario`, `climate-scenario`, `model_analysis`, `model-derived`, `ground-observation`.

## Static products (work on GitHub Pages and in Unreal without the API)

Served by the web app at `data/…` (from `data/cloudshadow/…`) and copied by `npm run web:build`. Unreal can read the same files from disk or over HTTP from `npm run web` (:8765).

| Path | Content | Built by |
| --- | --- | --- |
| `data/fields/index.json`, `data/fields/<site|global>/<year>.json/.wind.png/.scalars.png` | GEOS-FP wind/temperature/pressure frames 2018–2026 (`flow-field/1.0`) | `npm run data:fields` |
| `data/projections/<site>.json` | NEX-GDDP-CMIP6 climate to 2100 (`climate-projection/1.0`) | `python -m services.models.projections.build` |
| `data/plumes/colossus1.json` | Plume χ/Q footprint (`plume-scenario/1.0`, assumed 20 m effective height) | `python -m services.models.projections.plume` |
| `data/series/<site>.json`, `data/unreal/timeline/<site>.json` | Existing web trend series and timeline rows | `npm run data:nasa`, `npm run data:unreal` |

Formats: `docs/flow-fields.md` (with the Niagara recipe) and `docs/projections.md`.

## Where each product belongs (Part 3 to-do)

- [ ] **Timeline future zone (2027+):** show `data/projections/<site>.json` (SSP2-4.5/SSP5-8.5 medians with model whiskers) **next to** the existing "if the trend continues" extrapolation, clearly labelled "climate scenario". Don't merge the two.
- [ ] **Colossus 1 plume:** replace the stylised smoke density with the `data/plumes/colossus1.json` χ/Q heat-map (relative), with Boxtown as a receptor label. Keep "screening scenario, assumed stack height" in the legend.
- [ ] **Water layer:** chart the Giovanni series (groundwater, soil moisture, rainfall) or ERA5/USGS through `trend-analysis`. There is no river-flow animation yet (see issue #4 §6).
- [ ] **Live mode (click anywhere):** offer "Run climate projection" and "Run plume screening" for the clicked point via the job API when it is running locally (1–5 min jobs; show WebSocket progress).
- [ ] **Unreal:** drive Niagara wind from `fields/*.wind.png` and plume direction from `siteSeries`; show the projection chart in UMG.
- [ ] UI coherence items in issue #4: one wind number, no 3D columns, layer groups and legends.

## Not provided by Parts 1–2 (don't fake in the UI)

Pollutant chemistry and monitor-calibrated concentrations, hydrology/groundwater balance, water-quality transport, crop yield and noise models. See `docs/projections.md` → "What still remains". Show these as **unavailable** with the stated reason.
