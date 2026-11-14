# Goofy Goobers - Environmental and Agricultural Trend Detective

NASA Space Apps Challenge 2026: **[Be An Earth System Trend Detective!](https://www.spaceappschallenge.org/2026/challenges/earth-system-trend-detective/)**

Investigate how environmental conditions change around data-center regions, and how those changes could affect ecosystems and local agriculture over time. Compare historical trends and, when validated models are available, conditional future scenarios for facility expansion, cooling, emissions, water use and land changes.

## Current scope

The agreed scope is **environmental, including agriculture**:

- **Air:** pollutant emissions, air quality and supported indicators of pollution exposure.
- **Water:** withdrawals, consumption, availability, soil moisture, water quality and receiving-water conditions.
- **Land and ecosystems:** air and land-surface temperature, heat, vegetation, land cover, soil conditions and habitat indicators.
- **Noise:** equipment noise, background conditions and propagation where suitable ground evidence exists.
- **Agriculture:** how heat, drought, rainfall, soil moisture, irrigation-water availability/quality, land changes and air pollution could affect crop health, growing suitability and yield risk in the surrounding area.

**Social and economic outcomes are out of scope:** population, employment/unemployment, household or facility electricity bills, tariffs, income and economic-impact forecasts. Electricity/fuel-use information may be used as an input when needed to estimate environmental emissions; energy-market and bill forecasting are not project outputs.

Coverage is **global, using all available relevant history with particular attention to recent years**, through bounded, resumable acquisitions rather than downloading every NASA archive to one laptop. Historical NASA observations/model products, rate of change and statistical significance remain central to the challenge. Facility release records and local ground observations are needed alongside NASA data; a permitted emission limit is not an actual measured release. Nearby changes alone do not establish that a data center caused them.

Future environmental and agricultural estimates are **planned conditional scenarios**, not guaranteed predictions. State assumptions, supported horizons, data gaps and uncertainty explicitly.

## Current state

The code currently published on `main` is an initial repository foundation, not a finished environmental or agricultural predictor. It includes a runnable legacy **Node -> queued Python worker -> result manifest** workflow, HTTP status/results, WebSocket notifications, shared contracts, synthetic inputs, and integration tests. The scope above describes the intended product; it does not claim that those scientific capabilities are already implemented.

The retained legacy demo produces four transparent annual accounting series from invented inputs: facility electricity, grid-electricity CO2e, onsite cooling-water **use**, and a fixed-price facility energy bill. All results are labeled `illustrative`, use synthetic provenance, and report uncertainty as `not_quantified`. The remaining domains return explicit reasons under `unavailable`; map `layers` is empty.

**The current `main` scaffold has no live NASA adapters, calibrated pollution/hydrology/acoustic/crop models, long-range environmental forecasts, or compiled Unreal project yet.** Selecting a future year only extends the supplied arithmetic assumptions; it does not demonstrate predictive skill.

## The three main parts

| Part | General explanation | Where it lives |
| --- | --- | --- |
| **1. Data and backend** | Collect evidence, normalize it, manage scenarios/jobs, preserve provenance, and provide the client API | `apps/api/`, `packages/contracts/`, `data/` |
| **2. Projection engine** | Run environmental trend analysis and future environmental/agricultural models with explicit scales, supported horizons, and uncertainty | `services/models/` |
| **3. Interactive explorer** | Navigate the globe, select facilities and agricultural areas, adjust supported assumptions, compare timelines, and display environmental results with evidence labels | `clients/unreal/` |

```mermaid
flowchart LR
    U[Unreal + Cesium] <-->|HTTP requests and results| A[Node.js API]
    A -->|WebSocket job status| U
    A -->|Queued scenario via stdin| M[Python model worker]
    M -->|Result manifest via stdout| A
    D[NASA and regional records] -. future adapters .-> A
    T[Globe tile provider] -->|Independent streaming| U
```

## Repository structure

```text
.
|-- apps/api/src/             # Local Node/TypeScript API and in-process FIFO queue
|   |-- server.ts             # HTTP endpoints and read-only WebSocket event streams
|   |-- run-manager.ts        # queued -> running -> completed / failed
|   |-- model-worker.ts       # Async Python process, timeout and output validation
|   `-- validation.ts         # Shared JSON Schema and cross-field checks
|-- services/models/          # Python standard-library-only accounting worker
|   |-- accounting.py         # Validated formulas, metadata and unavailable domains
|   |-- worker.py             # One stdin request -> one stdout manifest
|   `-- tests/                # Numerical, validation and process-protocol checks
|-- packages/contracts/       # JSON Schemas, TypeScript types and domain registry
|-- clients/unreal/           # Unreal/Cesium implementation track, not a .uproject
|-- data/
|   |-- examples/             # Small synthetic scenario fixture
|   |-- raw/                  # Future source downloads; generated contents ignored
|   |-- processed/            # Future normalized observations and layers; ignored
|   `-- runs/                 # Future local artifacts; current runs are in memory
|-- docs/
|   |-- architecture.md       # Component boundaries, lifecycle and evolution
|   |-- api.md                # HTTP, WebSocket, worker and manifest contracts
|   |-- unreal-integration.md # Globe, networking, UI, terrain and acceptance checks
|   |-- modeling.md           # Domain models, attribution, validation and uncertainty
|   |-- resources.md          # All 13 challenge resources plus repositories/sources
|   `-- roadmap.md            # Milestones and completion criteria
|-- scripts/demo.ts           # Submit, subscribe, poll and fetch an actual demo run
|-- tests/api.test.ts         # HTTP/WS/real Python integration and failure paths
`-- .github/workflows/ci.yml  # Linux + Windows checks
```

## Run the local starter

Prerequisites: **Node.js 24.12+** (supported majors 24-26), npm, and **Python 3.11+** available as `python`. Unreal, a GPU, Earthdata credentials and Google/Cesium accounts are not required for this demo. TypeScript executes through Node's built-in type stripping; `npm run typecheck` performs the separate static check. See [Node's TypeScript documentation](https://nodejs.org/api/typescript.html).

```sh
git clone https://github.com/Moustafa-FD/NasaSpaceHacks2026GoofyGoobers.git
cd NasaSpaceHacks2026GoofyGoobers
npm ci
```

Optional environment setup:

```sh
# macOS/Linux
cp .env.example .env
```

```powershell
# PowerShell
Copy-Item .env.example .env
```

If Python is not available under `python`, set `PYTHON_EXECUTABLE` in `.env` to its executable name or full path. The runtime worker uses that setting. The `test:models` script uses `python` directly; invoke the same `-m unittest discover -s services/models/tests -v` arguments with your chosen executable if needed.

Start the API in terminal 1:

```sh
npm start
```

Run the end-to-end client in terminal 2:

```sh
npm run demo
```

It submits [the synthetic example](data/examples/scenario.json), prints WebSocket status snapshots, polls authoritative HTTP status, and prints the completed manifest. Polling and notification handling are bounded; failures and timeouts are reported rather than converted into numbers.

Local defaults: `http://127.0.0.1:3000`, one active worker, at most 32 waiting runs, at most 200 stored runs per process, 64 event clients, a 64 KiB request limit, and a 30-second worker timeout. Limits reject excess work explicitly. There is no durable database or public authentication: restart clears runs/results, and the server binds to loopback only. A deployed service needs a deliberate HTTPS/WSS/authentication and persistence design.

Commands:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Watch API source and restart on changes; a restart clears runs |
| `npm run typecheck` | Check TypeScript contracts and API code |
| `npm test` | Exercise HTTP, WebSockets and the real Python worker |
| `npm run test:models` | Check hand-computed accounting, units, leap years and invalid inputs |
| `npm run check` | Run all required checks |

## 1. Data and backend - implementation work

**Implemented:** scenario validation, an in-memory run registry and FIFO queue, asynchronous worker execution, typed contracts, result validation, HTTP status/results, and WebSocket notifications.

**Next:**

1. Build a global facility/source inventory and acquire accessible recent records before extending history. Document facility locations/opening dates, reported emissions, generator schedules, cooling/water definitions, withdrawals, consumption and return flows. Add nearby cropland, crop types/calendars, soil conditions, irrigation practices and ground observations where available. Do not infer private operating figures from a building footprint.
2. Implement one quality-controlled NASA time-series adapter, using [GES DISC tutorials](https://github.com/nasa/gesdisc-tutorials), [Giovanni](https://giovanni.gsfc.nasa.gov/), and/or [AppEEARS examples](https://github.com/nasa/AppEEARS-Data-Resources). Preserve collection versions, quality flags, resolution, units, citations and retrieval dates.
3. Add regional air/water monitoring, soil and crop records, facility release reports and relevant permits. Map each facility to its watershed/aquifer, airshed and surrounding agricultural areas rather than using one radius for every environmental pathway. Keep measured/reported releases, permit limits and modeled estimates distinct.
4. Store observations separately from assumptions. Add historical trend magnitude, significance, comparison areas and missing-data handling.
5. Replace the demonstration registry with persisted run records, a durable job queue, PostGIS for geographic entities, and object storage for larger products. Those infrastructure components are planned, not current prerequisites.

## 2. Projection engine - implementation work

| Environmental domain | Current state on main | Required implementation |
| --- | --- | --- |
| Historical trends | Planned scientific analysis | Quality-controlled time series, seasonal treatment, rate of change, significance, comparison areas and uncertainty |
| Emissions / air quality | Legacy illustrative grid CO2e accounting only | Actual facility releases, onsite/offsite sources, emissions inventories, transport/chemistry, ground calibration and appropriate AQ indicators |
| Water availability | Legacy illustrative onsite water-use total only | Withdrawals versus consumption/return flows, seasonal supply, competing uses, watershed and groundwater dynamics |
| Water quality | Planned | Discharge volume, chemistry, treatment, temperature, receiving-water observations and transport/reactions |
| Land / soil / ecosystems | Planned | Quality-controlled temperature, soil-moisture/condition, vegetation, land-cover and habitat indicators with supported interpretation |
| Noise pollution | Planned | Equipment sound power/spectra, schedules, background measurements, receptors, propagation/barriers, mitigation and acoustic validation |
| Agriculture | Planned | Crop types/calendars, soil and irrigation data, growing-season heat/drought/water/pollution exposure, observed crop condition/yields and calibrated crop-response models |

The retained legacy demo formulas are deliberately inspectable. Its electricity and bill series are transport/accounting fixtures, not outputs in the agreed product scope:

```text
IT kWh = starting IT MW * 1000 * utilization * calendar hours * (1 + growth)^(year - start)
Facility kWh = IT kWh * PUE
Grid tonnes CO2e = facility kWh * supplied kg CO2e/kWh / 1000
Cooling water use (litres) = IT kWh * supplied litres/IT-kWh
Facility energy charge = facility kWh * supplied price/kWh
```

These use actual leap-year hours and fixed supplied factors; they contain no validated environmental or crop-response relationship. Water use is not net consumptive loss or water quality; CO2e inventory is not local pollutant concentration; an energy charge is not a complete tariff or a household bill. See [worker formulas](services/models/README.md).

For **2030/2050/2100 scenarios**, use supported climate inputs such as [NASA NEX-GDDP-CMIP6](https://ntrs.nasa.gov/citations/20240011616), then calibrated environmental/crop models and explicit facility, cooling, land-use and agricultural-management assumptions. Availability of climate scenarios through 2100 does not validate every environmental or agricultural metric to that date. [STRATA](https://huggingface.co/nvidia/strata) is an optional short-range atmospheric research adapter; autoregressive feedback does not establish decades-ahead accuracy. [Its paper](https://arxiv.org/abs/2606.31248) reports stable 24-hour rollouts and growing biases.

### Agriculture and future growing conditions

This planned track assesses environmental risks to agriculture, not farm income, employment or food-price forecasts.

- Combine growing-season temperature/rainfall, soil moisture, irrigation-water availability/quality, pollution exposure and land changes with crop-specific observations.
- Examine historical crop/vegetation stress and, where evidence supports it, future growing suitability, irrigation reliability and yield risk.
- Treat satellite vegetation indices as indicators of vegetation condition; they do not directly measure crop yield. Yield estimates need suitable observed yields and crop-specific calibration.
- Account for crop calendars, soil, management and climate scenarios. Validate against independent observations and report uncertainty and supported geographic/time scales.
- Compare a stated baseline with facility-development/cooling/emissions/water-use scenarios. Separate regional climate trends from any claimed additional data-center effect.

No crop model, agricultural-impact calculation or future yield forecast is implemented in the current main scaffold.

Every future result must record evidence class, native resolution, supported horizon, provenance, model version and uncertainty method. A low/central/high sensitivity range is not automatically a confidence interval. Compare an explicit no-additional-expansion baseline against interventions; do not attribute all nearby changes to data centers. [Modeling plan](docs/modeling.md)

## 3. Unreal + Cesium - implementation work

**Documented, not compiled:** follow [the client track](clients/unreal/README.md) and [integration guide](docs/unreal-integration.md). Record compatible engine/plugin versions when creating the actual Unreal project.

Build globe navigation, facility and agricultural-area selection, historical/future timelines, evidence-aware charts, scenario controls and comparisons. Future layers cover air quality, water availability/quality, soil and land conditions, crop health/stress, growing suitability, supported yield-risk scenarios and noise. Until a model exists, display its unavailability explanation instead of a zero, plume, contour or invented map.

Use [Cesium for Unreal](https://cesium.com/learn/unreal/unreal-quickstart/) and optionally [Google Photorealistic 3D Tiles](https://cesium.com/learn/unreal/unreal-photorealistic-3d-tiles/). A detailed globe does not improve scientific resolution. Stream the base map independently from the backend's numerical outputs and preserve [provider attribution/data-use requirements](https://developers.google.com/maps/documentation/tile/policies).

For local terrain editing, use independently sourced elevation/geometry and your own Landscape or dynamic mesh. Streamed Google tiles are not editable Unreal Landscapes. Visual clipping also needs separate collision handling. Terrain/facility edits become simulation inputs only when a relevant model supports the numerical change; otherwise they remain visual scenarios.

### How Unreal communicates

```mermaid
sequenceDiagram
    participant U as Unreal
    participant A as Node API
    participant M as Python worker
    U->>A: POST /v1/runs (region, years, assumptions)
    A-->>U: 202 Accepted + run ID + URLs
    A->>M: Queue and execute calculation
    U->>A: Connect to run events WebSocket
    A-->>U: Immediate current status snapshot
    M-->>A: Manifest or error
    A-->>U: completed / failed event
    U->>A: GET results after completion
    A-->>U: Charts, provenance, unavailable domains, layers
```

| Operation | Actual starter interface |
| --- | --- |
| Discover status/capabilities | `GET /health`, `GET /v1/domains` |
| Start a calculation | `POST /v1/runs` returns immediately with a queued run ID |
| Check status or recover a disconnect | `GET /v1/runs/{id}` |
| Receive notifications | `ws://127.0.0.1:3000/v1/runs/{id}/events` |
| Download completed output | `GET /v1/runs/{id}/results` |

Unreal talks to the Node gateway for simulation work, not each model separately. Implement an asynchronous HTTP/WebSocket connector, expose its events to Blueprint widgets, and keep network waits off the rendering path. The event stream sends the latest snapshot on connection; HTTP status is authoritative after reconnect. It does not accept commands or promise replay.

Cache completed results by run ID. **Moving the timeline reads saved samples; pressing Run scenario after changing assumptions creates a new job.** In future, large layers will be fetched separately using result-manifest URLs. The initial `layers: []` intentionally supplies no map surfaces. Local HTTP/WS becomes authenticated HTTPS/WSS for deployment. See [exact payloads and failure handling](docs/api.md).

## Resources and next steps

The [resource catalog](docs/resources.md) includes **all 13 official challenge entries**, the NASA repositories discussed, and sources needed beyond NASA: facility emissions reports, ground air/water-quality measurements, soil/crop/irrigation records and acoustic measurements. Links are references for planned adapters, not claims that integrations already work.

Start with the [roadmap](docs/roadmap.md), then use [contribution guidance](CONTRIBUTING.md). Data/product licenses and API-provider terms must be tracked separately. A project code license has not yet been selected; this starter does not invent ownership or relicense linked resources.
